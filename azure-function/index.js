/*
 * This is the Azure Function backing the GitGitGadget GitHub App.
 *
 * As Azure Functions do not support Typescript natively yet, we implement it in
 * pure Javascript and keep it as simple as possible.
 * 
 * Note: while the Azure Function Runtime v1 supported GitHub webhooks natively,
 * via the "webHookType", we want to use v2, so we have to do the payload
 * validation "by hand".
 */
const crypto = require('crypto');
const https = require('https');

const validateGitHubWebHook = (context) => {
    const secret = process.env['GITHUB_WEBHOOK_SECRET'];
    if (!secret) {
        throw new Error('Webhook secret not configured');
    }
    if (context.req.headers['content-type'] !== 'application/json') {
        throw new Error('Unexpected content type: ' + context.req.headers['content-type']);
    }
    const signature = context.req.headers['x-hub-signature'];
    if (!signature) {
        throw new Error('Missing X-Hub-Signature');
    }
    const sha1 = signature.match(/^sha1=(.*)/);
    if (!sha1) {
        throw new Error('Unexpected X-Hub-Signature format: ' + signature);
    }
    const computed = crypto.createHmac('sha1', secret).update(context.req.rawBody).digest('hex');
    if (sha1[1] !== computed) {
        throw new Error('Incorrect X-Hub-Signature');
    }
}

const triggerAzurePipeline = async (token, organization, project, buildDefinitionId, sourceBranch, parameters) => {
    const auth = Buffer.from('PAT:' + token).toString('base64');
    const headers = {
        'Accept': 'application/json; api-version=5.0-preview.5; excludeUrls=true',
        'Authorization': 'Basic ' + auth,
    };
    const json = JSON.stringify({
        'definition': { 'id': buildDefinitionId },
        'sourceBranch': sourceBranch,
        'parameters': JSON.stringify(parameters),
    });
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(json);

    const requestOptions = {
        host: 'dev.azure.com',
        port: '443',
        path: `/${organization}/${project}/_apis/build/builds?ignoreWarnings=false&api-version=5.0-preview.5`,
        method: 'POST',
        headers: headers
    };

    return new Promise((resolve, reject) => {
        const handleResponse = (res, err) => {
            res.setEncoding('utf8');
            var response = '';
            res.on('data', (chunk) => {
                response += chunk;
            });
            res.on('end', () => {
                resolve(JSON.parse(response));
            });
            res.on('error', (err) => {
                reject(err);
            })
        };

        const request = https.request(requestOptions, handleResponse);
        request.write(json);
        request.end();
    });
}

module.exports = async (context, req) => {
    try {
        validateGitHubWebHook(context);
    } catch (e) {
        context.log('Caught ' + e);
        context.res = {
            status: 403,
            body: 'Not a valid GitHub webhook: ' + e,
        };
        context.done();
        return;
    }

    try {
        const eventType = context.req.headers['x-github-event'];
        context.log(`Got eventType: ${eventType}`);
        if (req.body.repository.owner.login !== 'gitgitgadget') {
            context.res = {
                status: 403,
                body: 'Refusing to work on a repository other than gitgitgadget/git'
            };
        } else if ((new Set(['check_run', 'status']).has(eventType))) {
            context.res = {
                body: `Ignored event type: ${eventType}`,
            };
        } else if (eventType === 'issue_comment') {
            const triggerToken = process.env['GITGITGADGET_TRIGGER_TOKEN'];
            if (!triggerToken) {
                throw new Error('No configured trigger token');
            }

            const comment = req.body.comment;
            const pullRequestURL = req.body.issue.pull_request.html_url;
            const prNumber = pullRequestURL.match(/https:\/\/github\.com\/gitgitgadget\/git\/pull\/([0-9]*)$/)
            if (!comment.id || !prNumber) {
                context.log(`Invalid payload:\n${JSON.stringify(req.body, null, 4)}`);
                throw new Error('Invalid payload');
            }

            /* Only trigger the Pipeline for valid commands */
            if (!comment.body || !comment.body.match(/^\/(submit|allow|disallow|test)\b/)) {
                context.res = {
                    body: `Not a command: '${comment.body}'`,
                };
                context.done();
                return;
            }

            const sourceBranch = `refs/pull/${prNumber[1]}/head`;
            const parameters = {
                'pr.comment.id': comment.id,
            };
            context.log(`Queuing with branch ${sourceBranch} and parameters ${JSON.stringify(parameters)}`);
            await triggerAzurePipeline(triggerToken, 'gitgitgadget', 'git', 3, sourceBranch, parameters);

            context.res = {
                // status: 200, /* Defaults to 200 */
                body: 'Okay!',
            };
        } else {
            context.log(`Unhandled request:\n${JSON.stringify(req, null, 4)}`);
            context.res = {
                body: 'No idea what this is about, but okay.',
            };
        }
    } catch (e) {
        context.log('Caught exception ' + e);
        context.res = {
            status: 500,
            body: 'Caught an error: ' + e,
        };
    }

    context.done();
};
