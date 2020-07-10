/* eslint-disable @typescript-eslint/camelcase */

import { getInput, setFailed } from '@actions/core';
import { context } from '@actions/github';
import { Octokit } from '@octokit/action';
import execa from 'execa';

import { isGitHubActions, debug } from './actions';

let commentHeader: string;

const getArguments = (): string[] => {
  const inputs = {
    config: getInput('config'),
    graph: getInput('graph'),
    variant: getInput('variant'),
    endpoint: getInput('endpoint'),
    header: getInput('header'),
    key: getInput('key'),
    localSchemaFile: getInput('localSchemaFile'),
    queryCountThreshold: getInput('queryCountThreshold'),
    queryCountThresholdPercentage: getInput('queryCountThresholdPercentage'),
    serviceName: getInput('serviceName'),
    validationPeriod: getInput('validationPeriod')
  };
  const args = [];

  debug('token', !!process.env.GITHUB_TOKEN);

  if (inputs.graph && !inputs.key) {
    throw new Error('You must provide an Apollo key');
  }

  if (!inputs.config && !inputs.graph) {
    throw new Error('You must provide either a config file or a graph name');
  }

  for (const [key, value] of Object.entries(inputs)) {
    if (key === 'header') {
      const headers = value.split(',');

      for (const header of headers) {
        args.push(`--header='${header.trim()}'`);
      }
    } else if (value) {
      args.push(`--${key}=${value}`);
    }
  }

  args.push('--markdown');

  debug('Apollo CLI argument string', args.join(' '));

  return args;
};

const formatMessage = (output: string, existingComment: boolean): string | undefined => {
  const startOfMessage = output.indexOf('###');
  const title = getInput('title');
  const alwaysComment = getInput('alwaysComment');
  const failOnError = getInput('failOnError');

  if (startOfMessage === -1) {
    throw new Error('Error running Apollo CLI');
  }

  if (alwaysComment !== 'true' && output.includes('null operations')) {
    debug('alwaysComment is false and number of operations is null');
    debug('output', output);

    return;
  }

  if (!existingComment && alwaysComment !== 'true' && /\s0 schema changes/.test(output)) {
    debug('existingComment is false, alwaysComment is false and there are zero schema changes');
    debug('output', output);

    return;
  }

  if (failOnError && /\d+ breaking change/.test(output)) {
    debug('Breaking changes found');
    setFailed('Breaking changes found');
  } else if (failOnError && /\d+ composition error/.test(output)) {
    debug('Composition errors found');
    setFailed('Composition errors found');
  }

  let message = output.slice(startOfMessage);

  if (title) {
    message = message.replace('Apollo Service Check\n', `Apollo Schema Check\n#### ${title}\n`);
  } else {
    message = message.replace('Apollo Service Check', `Apollo Schema Check`);
  }

  debug('message', message);

  return message;
};

const getMessage = async (existingComment: boolean): Promise<string | undefined> => {
  const config = getInput('config');
  const graph = getInput('graph');
  const variant = getInput('variant');
  const args = getArguments();

  if (existingComment) {
    debug('existing comment found');
  }

  if (config) {
    commentHeader = `<!-- apolloSchemaCheckAction config: ${config} -->`;
  } else if (graph && variant) {
    commentHeader = `<!-- apolloSchemaCheckAction graph: ${graph}@${variant} -->`;
  } else if (graph) {
    commentHeader = `<!-- apolloSchemaCheckAction graph: ${graph} -->`;
  } else if (variant) {
    commentHeader = `<!-- apolloSchemaCheckAction variant: ${variant} -->`;
  } else {
    commentHeader = `<!-- apolloSchemaCheckAction -->`;
  }

  try {
    const output = (await execa('npx', ['apollo@2.28.3', 'schema:check', ...args])).stdout;
    const message = formatMessage(output, existingComment);

    if (message) {
      return `${commentHeader}\n\n${message}`;
    } else {
      return;
    }
  } catch (error) {
    if (error.exitCode !== 1) {
      debug('Apollo CLI error', error);

      throw new Error('Error running Apollo CLI');
    } else {
      const message = formatMessage(error.stdout, existingComment);

      if (message) {
        return `${commentHeader}\n\n${message}`;
      } else {
        return;
      }
    }
  }
};

const run = async (): Promise<void> => {
  if (!isGitHubActions()) {
    console.log(await getMessage(false));

    return;
  }

  try {
    if (context.payload.pull_request == null) {
      setFailed('No pull request found');

      return;
    }

    const githubRepo = process.env.GITHUB_REPOSITORY;

    if (!githubRepo) {
      setFailed('No repo found');

      return;
    }

    const [owner, repo] = githubRepo.split('/');
    const pullRequestNumber = context.payload.pull_request.number;
    const octokit = new Octokit();
    const comments = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pullRequestNumber
    });
    const existingComment = comments.data.find(comment => comment.body.startsWith(commentHeader));
    const message = await getMessage(!!existingComment);

    if (message) {
      if (existingComment) {
        octokit.issues.updateComment({
          ...context.repo,
          comment_id: existingComment.id,
          body: message
        });
      } else {
        octokit.issues.createComment({
          ...context.repo,
          issue_number: pullRequestNumber,
          body: message
        });
      }
    }
  } catch (error) {
    setFailed(error.message);
  }
};

run();
