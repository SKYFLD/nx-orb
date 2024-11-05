#!/usr/bin/env node
const { execSync } = require('child_process');
const https = require('https');

const organizationId = process.argv[2];
const projectId = process.argv[3];
const branchName = process.argv[4];
const mainBranchName = process.env.MAIN_BRANCH_NAME || process.argv[5];
const errorOnNoSuccessfulWorkflow = process.argv[6] === '1';
const allowOnHoldWorkflow = process.argv[7] === '1';
const skipBranchFilter = process.argv[8] === '1';
const workflowName = process.argv[9];
const mainTagRegex = process.argv[10] || ""
const circleToken = process.env.CIRCLE_API_TOKEN;

const host = "circleci.com";
const project = `circleci/${organizationId}/${projectId}`;

let BASE_SHA;
(async () => {
  if (branchName !== mainBranchName) {
    BASE_SHA = execSync(`git merge-base origin/${mainBranchName} HEAD`, { encoding: 'utf-8' });
  } else {
    try {
      BASE_SHA = await findSuccessfulCommit(skipBranchFilter ? undefined : mainBranchName, workflowName, mainTagRegex);
    } catch (e) {
      process.stderr.write(e.message);
      if (errorOnNoSuccessfulWorkflow) {
        process.exit(1);
      } else {
        process.stdout.write(`
WARNING: Accessing CircleCI API failed on 'origin/${mainBranchName}'.
This might be a temporary issue with their API or a misconfiguration of the CIRCLE_API_TOKEN.
We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'.

NOTE: You can instead make this a hard error by settting 'error-on-no-successful-workflow' on the step in your workflow.\n\n`);
        BASE_SHA = execSync(`git rev-parse origin/${mainBranchName}~1`, { encoding: 'utf-8' });
      }
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow) {
        process.stdout.write(`
    Unable to find a successful workflow run on 'origin/${mainBranchName}'
    NOTE: You have set 'error-on-no-successful-workflow' on the step so this is a hard error.

    Is it possible that you have no runs currently on 'origin/${mainBranchName}'?
    - If yes, then you should run the workflow without this flag first.
    - If no, then you might have changed your git history and those commits no longer exist.`);
        process.exit(1);
      } else {
        process.stdout.write(`
WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}'.
We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'.

NOTE: You can instead make this a hard error by settting 'error-on-no-successful-workflow' on the step in your workflow.\n\n`);
        BASE_SHA = execSync(`git rev-parse origin/${mainBranchName}~1`, { encoding: 'utf-8' });
      }
    } else {
      process.stdout.write(`
Found the last successful workflow run on 'origin/${mainBranchName}'.\n\n`);
    }
  }

  process.stdout.write(`Commit: ${BASE_SHA}\n\n`);
})();

async function findSuccessfulCommit(branch, workflowName, tagRegex) {
  const url = `https://${host}/api/v2/project/${project}/pipeline?`;
  const params = branch && (tagRegex.length === 0) ? [`branch=${branch}`] : [];

  process.stdout.write(`Checking this URL ${url}${fullParams}.`);
  let nextPage;
  let foundSHA;

  do {
    const fullParams = params.concat(nextPage ? [`page-token=${nextPage}`] : []).join('&');
    const { next_page_token, sha } = await getJson(`${url}${fullParams}`)
      .then(async ({ next_page_token, items }) => {
        const pipeline = await findSuccessfulPipeline(items, workflowName, tagRegex);
        return {
          next_page_token,
          sha: pipeline ? pipeline.trigger_parameters.github_app.commit_sha : void 0
        };
      });

    foundSHA = sha;
    nextPage = next_page_token;
  } while (!foundSHA && nextPage);

  return foundSHA;
}

async function findSuccessfulPipeline(pipelines, workflowName, tagRegex) {
  for (const pipeline of pipelines) {
    
    const pipelineSuccessfulCheck = !pipeline.errors.length
      && commitExists(pipeline.trigger_parameters.github_app.commit_sha)
      && await isWorkflowSuccessful(pipeline.id, workflowName);

    if (!pipelineSuccessfulCheck)
      continue;

    if (tagRegex.length > 0 && !pipeline.trigger_parameters.github_app.tag) 
      continue;

    if (pipeline.trigger_parameters.github_app.tag){
      const re = new RegExp(tagRegex);
      if (re.test(pipeline.trigger_parameters.github_app.tag)) 
        return pipeline

    } else return pipeline;
  }
  return undefined;
}

function commitExists(commitSha) {
  try {
    execSync(`git merge-base --is-ancestor ${commitSha} ${mainBranchName}`, { stdio: ['pipe', 'pipe', null] });
    return true;
  } catch {
    return false;
  }
}

async function isWorkflowSuccessful(pipelineId, workflowName) {
  if (!workflowName) {
    return getJson(`https://${host}/api/v2/pipeline/${pipelineId}/workflow`)
      .then(({ items }) => items.every(item => (item.status === 'success') || (allowOnHoldWorkflow && item.status === 'on_hold')));
  } else {
    return getJson(`https://${host}/api/v2/pipeline/${pipelineId}/workflow`)
      .then(({ items }) => items.some(item => ((item.status === 'success') || (allowOnHoldWorkflow && item.status === 'on_hold')) && item.name === workflowName));
  }
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    let options = {};

    if (circleToken) {
      options.headers = {
        'Circle-Token': circleToken
      }
    }

    https.get(url, options, (res) => {
      let data = [];

      res.on('data', chunk => {
        data.push(chunk);
      });

      res.on('end', () => {
        const response = Buffer.concat(data).toString();
        try {
          const responseJSON = JSON.parse(response);
          resolve(responseJSON);
        } catch (e) {
          if (response.includes('Project not found')) {
            reject(new Error(`Error: Project not found.\nIf you are using a private repo, make sure the CIRCLE_API_TOKEN is set.\n\n${response}`));
          } else {
            reject(e)
          }
        }
      });
    }).on('error', error => reject(
      circleToken
        ? new Error(`Error: Pipeline fetching failed.\nCheck if you set the correct user CIRCLE_API_TOKEN.\n\n${error.toString()}`)
        : new Error(`Error: Pipeline fetching failed.\nIf this is private repo you will need to set CIRCLE_API_TOKEN\n\n${error.toString()}`)
    ));
  });
}
