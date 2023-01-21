import core from '@actions/core';
import {getOctokit, context} from '@actions/github';
import fetch from 'node-fetch';
import { WorkflowFileEntryData } from './src/types';

export const prerun = async () => {
  const token = core.getInput('token', {required: true});
  const api = getOctokit(token);
  const workflowFile = await api.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId,
  })
    .then(({data}) => {
      const currentWorkflowUrl = data.workflow_url;
      core.info(`Current workflow url: ${currentWorkflowUrl}`);
      return fetch(currentWorkflowUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        })
      })
    .catch((error: Error) => {
      throw new Error(`Unable to initialize SimpleCache: ${error.message}`);
    })
    .then((data) => data.json() as Promise<{path: string}>)
    .catch((error: Error) => {
      throw new Error(`Unable to format response: ${error.message}`);
    })
    .then(({path}) => path);
    core.info(`Current workflow file: ${workflowFile}`);
    const workflowFileContent = await api.request('GET /repos/{owner}/{repo}/git/trees/{commit}?recursive=1', {
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit: context.sha,
    })
      .catch((error: Error) => {
        throw new Error(`Unable to access current commit tree: ${error.message}`);
      })
      .then(({data}) => data.tree)
      .catch((error: Error) => {
        throw new Error(`Unable to access commit tree from API response: ${error.message}`);
      })
      .then((tree): WorkflowFileEntryData => {
        const workflowFileEntry = tree.find((file: {[key: string]: string}) => file.path === workflowFile);
        if (!workflowFileEntry) {
          throw new Error(`Unable to find workflow file in commit tree: ${workflowFile}`);
        }
        return workflowFileEntry;
      })
      .then(({url}) => {
        return fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
      })
      .catch((error: Error) => {
        throw new Error(`Unable to fetch workflow file content: ${error.message}`);
      })
      .then((data) => data.json() as Promise<{content: string}>)
      .catch((error: Error) => {
        throw new Error(`Unable to format response: ${error.message}`);
      })
      .then(({content}) => Buffer.from(content, 'base64').toString('utf-8'))
      .catch((error: Error) => {
        throw new Error(`Unable to decode workflow file content: ${error.message}`);
      });
      core.info(`Current workflow file content: ${workflowFileContent}`);
};
