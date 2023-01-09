import * as core from '@actions/core';
import fs from 'fs/promises';
import {
  create as createArtifactClient,
  ArtifactClient,
} from '@actions/artifact';
import { getOctokit, context } from '@actions/github';
import { SimpleCrypto } from "simple-crypto-js"
import LZString from 'lz-string';

import { GitHub } from '@actions/github/lib/utils';
import { CommitComparisonResponse } from './types.js';


class SimpleCache {
  repoPublicKey: string;
  repoPublicKeyId: string;
  artifactClient: ArtifactClient;
  authenticatedAPI: InstanceType<typeof GitHub>;
  source: string;
  target: string;
  encrypt: (input: string) => string;
  decrypt: (input: string) => string
  private static __instance: SimpleCache | undefined = undefined;

  constructor (
    authenticatedAPI: InstanceType<typeof GitHub>,
    repoPublicKey: string,
    repoPublicKeyId: string,
    source: string,
    target: string
  ) {
    this.authenticatedAPI = authenticatedAPI;
    this.repoPublicKey = repoPublicKey;
    this.repoPublicKeyId = repoPublicKeyId;
    this.artifactClient = createArtifactClient();
    this.source = source;
    this.target = target;
    const encryptor: SimpleCrypto = new SimpleCrypto(repoPublicKey);
    this.encrypt = (input: string) => encryptor.encrypt(input) as string;
    this.decrypt = (input: string) => encryptor.decrypt(input) as string;
  }

  static access = async function (token: string): Promise<SimpleCache> {
    if (!SimpleCache.__instance) {
      await SimpleCache.initialize(token)
        .then((instance: SimpleCache) => SimpleCache.__instance = instance);
    }
    return SimpleCache.__instance as SimpleCache;
  }

  private static initialize = async (token: string): Promise<SimpleCache> => {
    const authenticatedAPI = getOctokit(token)
    core.info('Successfully authenticated with GitHub API');
    return await authenticatedAPI.rest.actions.getRepoPublicKey({
      owner: context.repo.owner,
      repo: context.repo.repo,
    })
      .then(({data}) => {
        process.env['ACTIONS_RUNTIME_TOKEN'] = token;
        core.info(`Successfully retrieved repo public key`);
        core.info(`Repo public key: ${data.key}`);
        core.info(`Repo public key id: ${data.key_id}`);
        const {source, target} = this.determineDiffStates();
        return new SimpleCache(authenticatedAPI, data.key, data.key_id, source, target);
      })
      .catch((error) => {
        throw new Error(`Unable to initialize SimpleCache: ${error}`);
      })
  };

  diff = async function (this: SimpleCache, include: string, exclude: string): Promise<string> {
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

  save = async function (this: SimpleCache, tag: string, value: string): Promise<void> {
    const encryptedValue = this.encrypt(value);
    const compressedValue = LZString.compress(encryptedValue);
    await fs.writeFile(`${tag}`, compressedValue, 'utf-8')
      .then(() => core.info(`Cached value for ${tag}: ${value}`))
      .then(async () => await this.artifactClient.uploadArtifact(tag, [tag], `${process.env.GITHUB_WORKSPACE}/cache/${tag}`)
        .then(() => {
          core.setOutput('files', value)
          core.info(`Uploaded artifact for ${tag}`)
        })
        .catch((error) => {
          throw new Error(`Unable to cache ${tag}: ${error}`);
        })
      );
  };

  load = async function (this: SimpleCache, tag: string): Promise<string> {
    return await this.artifactClient.downloadArtifact(tag, `${process.env.GITHUB_WORKSPACE}/cache/`)
      .then(async ({downloadPath}: {downloadPath: string}) => {
        core.info(`Downloaded artifact to ${downloadPath}`);
        return await fs.readFile(downloadPath, 'utf-8')
          .catch(() => {
            throw new Error(`Unable to open artifact under path: ${downloadPath}`);
          })
          .then((encryptedValue: string) => this.decrypt(encryptedValue) as string)
          .then((value: string) => {
            core.info(`Cached value for ${tag}: ${value}`);
            return LZString.decompress(value) as string;
          });
      })
      .catch(() => {
        throw new Error(`Unable to download artifact: ${tag}`);
      })
  };
}

export default SimpleCache;
