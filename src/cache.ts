import * as core from '@actions/core';
import { getOctokit, context } from '@actions/github';
import * as Sodium from 'libsodium-wrappers';
import LZString from 'lz-string';

import { GitHub } from '@actions/github/lib/utils';
import { CommitComparisonResponse } from './types.js';

class DiffCache {
  repoPublicKey: string;
  repoPublicKeyId: string;
  authenticatedAPI: InstanceType<typeof GitHub>;
  source: string;
  target: string;
  private encryptor: (() => Promise<typeof Sodium>) | undefined = undefined;
  private __cache: { [key: string]: string } | undefined = undefined;
  private static __instance: DiffCache | undefined = undefined;

  constructor (
    authenticatedAPI: InstanceType<typeof GitHub>,
    repoPublicKey: string,
    repoPublicKeyId: string,
    source: string,
    target: string,
    encryptor: () => Promise<typeof Sodium>
  ) {
    this.authenticatedAPI = authenticatedAPI;
    this.repoPublicKey = repoPublicKey;
    this.repoPublicKeyId = repoPublicKeyId;
    this.source = source;
    this.target = target;
    this.encryptor = encryptor;
  }

  static access = async function (token: string): Promise<DiffCache> {
    if (!DiffCache.__instance) {
      await DiffCache.initialize(token)
        .then((instance: DiffCache) => DiffCache.__instance = instance);
    }
    process.env.GITHUB_TOKEN = token;
    process.env.ACTIONS_RUNTIME_TOKEN = token;
    return DiffCache.__instance as DiffCache;
  }

  private static initialize = async function (token: string): Promise<DiffCache> {
    const authenticatedAPI = getOctokit(token)
    core.info('Successfully authenticated with GitHub API');
    return await authenticatedAPI.rest.actions.getRepoPublicKey({
      owner: context.repo.owner,
      repo: context.repo.repo,
    })
      .then(async function ({data}) {
        core.info(`Successfully retrieved repo public key`);
        core.info(`Repo public key: ${data.key}`);
        core.info(`Repo public key id: ${data.key_id}`);
        const {source, target} = DiffCache.determineDiffStates();
        const sodium = async () => {
          await Sodium.ready;
          return Sodium;
        }
        return new DiffCache(authenticatedAPI, data.key, data.key_id, source, target, sodium);
      })
      .catch((error: Error) => {
        throw new Error(`Unable to initialize SimpleCache: ${error.message}`);
      })
  };

  diff = async function (this: DiffCache, include: string, exclude: string): Promise<string> {
    console.log(`Checking changed files using pattern ${include} ${exclude ? `and excluding according to pattern ${exclude}` : ''}`);
    return await this.authenticatedAPI.rest.repos.compareCommitsWithBasehead({
      owner: context.repo.owner,
      repo: context.repo.repo,
      basehead: `${this.source}...${this.target}`
    })
      .catch((error) => {
        throw new Error(`Unable to compare commits: ${error}`);
      })
      .then(async ({
          data,
          status: responseStatus,
        }: {
          data: CommitComparisonResponse,
          status: number,
        }) => {
        if (responseStatus != 200) {
          throw new Error('Request to compare commits failed');
        }
        if (!data.files || data.files?.length === 0) {
          throw new Error('No files changed');
        }
        const changedFiles = data.files
          ?.filter((file: {filename: string}) => file.filename.match(new RegExp(include)))
          .filter((file: {filename: string}) => !exclude || !file.filename.match(new RegExp(exclude)))
          .map((file: {filename: string}) => file.filename)
          .join(' ');
        core.info(`Changed files: ${changedFiles}`);
        return changedFiles as string;
      })
  };

  static determineDiffStates = (): { source: string, target: string } => {
    if (context.eventName === 'pull_request'){
      return {
        source: context.payload.pull_request?.base.sha,
        target: context.payload.pull_request?.head.sha
      };
    } else if (context.eventName === 'push') {
      return {
        source: context.payload.before,
        target: context.payload.after
      };
    } else {
      throw new Error(`${context.eventName} event type is not supported by SimpleCache. Check the documentation for supported events.`);
    }
  };

  save = async function (this: DiffCache, tag: string, value: string): Promise<void> {
    return await this.uploadCache(tag, value)
      .then(({status}) => {
        if (status != 201) {
          throw new Error(`Unable to upload cache named ${tag}`)
        }
        core.info(`Uploaded artifact for ${tag}`)
      })
      .catch((error: Error) => {
        throw new Error(error.message);
      });
  };

  uploadCache = async function (this: DiffCache, tag: string, value: string): Promise<{status: number}> {
    if (!this.__cache) {
      throw new Error('Cannot upload cache before loading it into memory. Check if you are calling load() before save()');
    }
    core.setOutput('files', value)
    core.info(`Saving cache for ${tag}...`)
    try {
      this.__cache = Object.assign(this.__cache, {[tag]: value});
      const cacheString = JSON.stringify(this.__cache);
      const compressedCache = LZString.compress(cacheString);
      core.info('Cache compressed!')
      return this.encrypt(compressedCache).then(async (encryptedCache: string) => {
        core.info('Cache encrypted!')
        return await this.authenticatedAPI.request(
          'PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
            owner: context.repo.owner,
            repo: context.repo.repo,
            secret_name: 'SMART_DIFF_CACHE',
            encrypted_value: encryptedCache,
            key_id: this.repoPublicKeyId
          }
        );
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Unable to encrypt cache: ${error.message}`);
      } else {
        throw new Error(`Unable to encrypt cache: ${error}`);
      }
    }
  };

  encrypt = async function (this: DiffCache, value: string): Promise<string> {
    const valueBytes = Uint8Array.from(Buffer.from(value));
    if (!this.encryptor) {
      throw new Error('Cannot encrypt cache before loading libsodium');
    }
    return await this.encryptor().then((SodiumInstance: typeof Sodium) => {
      const base64_variant = SodiumInstance.base64_variants.ORIGINAL;
      const keyBytes = SodiumInstance.from_base64(this.repoPublicKey, base64_variant);
      const encryptedBytes = SodiumInstance.crypto_box_seal(valueBytes, keyBytes);
      return SodiumInstance.to_base64(encryptedBytes, base64_variant);
    });
  };

  load = function (this: DiffCache, tag: string): string {
    if (!this.__cache) this.lazyLoadCache();
    const currentCache = this.__cache as {[key: string]: string};
    return Object.hasOwn(currentCache, tag) ? currentCache[tag] : '';
  };

  lazyLoadCache = async function (this: DiffCache): Promise<void> {
    const storedCache = core.getInput('cache');
    if (storedCache === 'true') {
      core.info('Cache is completely empty due to first time use. Using an empty JSON.');
      this.__cache = {};
      return;
    }
    core.info('Loaded encrypted cache passed through action input')
    try {
      const decompressedCache = LZString.decompress(storedCache) as string;
      core.info(decompressedCache)
      this.__cache = JSON.parse(decompressedCache);
    } catch (error) {
      core.error(error as Error);
      throw new Error(`Unable to decrypt and decompress cache!`);
    }
  };
}

export default DiffCache;
