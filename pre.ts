import core from '@actions/core';
import TriggeredWorkflow from './src/workflow.js';

const CACHE_SECRET_REGEXP = /cache_secret.*$/;

export const prerun = async () => {
  if (!core.getInput('cache_secret', {required: true})) {
    core.setFailed('No secret for cache provided.');
  }
  const token = core.getInput('token', {required: true});
  TriggeredWorkflow.auth(token)
    .then(async (workflow: TriggeredWorkflow) => {
      const workflowData = await workflow.data;
      const line = findSecretName(workflowData.content);
      core.info(`Found secret name: ${line}`);
    }
  );
};

const findSecretName = (content: string) => {
  const lineWithSecret = content.match(CACHE_SECRET_REGEXP);
  return lineWithSecret;
};
