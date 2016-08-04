'use strict';
const githubWebhooks = require('hapi-github-webhooks');
const hoek = require('hoek');
const async = require('async');
const boom = require('boom');
const Models = require('screwdriver-models');
let pipeline;
let job;
let build;

/**
 * Create a new job and start the build for an opened pull-request
 * @method pullRequestOpened
 * @param  {Object}       options
 * @param  {String}       options.eventId    Unique ID for this GitHub event
 * @param  {String}       options.pipelineId Identifier for the Pipeline
 * @param  {String}       options.jobId      Identifier for the Job
 * @param  {String}       options.name       Name of the new job (PR-1)
 * @param  {String}       [options.sha]      specific SHA1 commit to start the build with
 * @param  {Hapi.request} request Request from user
 * @param  {Hapi.reply}   reply   Reply to user
 */
function pullRequestOpened(options, request, reply) {
    const eventId = options.eventId;
    const pipelineId = options.pipelineId;
    const jobId = options.jobId;
    const name = options.name;
    const sha = options.sha;

    async.waterfall([
        // Create job
        (next) => job.create({ pipelineId, name }, next),
        // Log it
        (jobData, next) => {
            request.log(['webhook-github', eventId, jobId], `${jobData.name} created`);
            next();
        },
        (next) => pipeline.get(pipelineId, next),
        // Log it
        (pipelineData, next) => {
            const username = Object.keys(pipelineData.admins)[0];

            request.log([
                'webhook-github',
                eventId,
                jobId,
                pipelineId
            ], `${username} admin selected`);
            next(null, username);
        },
        // Create build
        (username, next) => {
            const apiUri = request.server.info.uri;
            const tokenGen = (buildId) =>
                request.server.plugins.login.generateToken(buildId, ['build']);

            build.create({ jobId, sha, username, apiUri, tokenGen }, next);
        },
        // Log it
        (buildData, next) => {
            request.log(['webhook-github', eventId, jobId, buildData.id], `${name} started `
                + `${buildData.number}`);
            next();
        }
    ], (waterfallError) => {
        if (waterfallError) {
            return reply(boom.wrap(waterfallError));
        }

        return reply().code(201);
    });
}

/**
 * Stop any running builds and disable the job for closed pull-request
 * @method pullRequestClosed
 * @param  {Object}       options
 * @param  {String}       options.eventId    Unique ID for this GitHub event
 * @param  {String}       options.pipelineId Identifier for the Pipeline
 * @param  {String}       options.jobId      Identifier for the Job
 * @param  {String}       options.name       Name of the job (PR-1)
 * @param  {Hapi.request} request Request from user
 * @param  {Hapi.reply}   reply   Reply to user
 */
function pullRequestClosed(options, request, reply) {
    const eventId = options.eventId;
    const jobId = options.jobId;
    const name = options.name;

    // @TODO stop running build
    job.update({
        id: jobId,
        data: {
            state: 'DISABLED'
        }
    }, (updateError) => {
        if (updateError) {
            return reply(boom.wrap(updateError));
        }
        request.log(['webhook-github', eventId, jobId], `${name} disabled`);

        return reply().code(200);
    });
}

/**
 * Stop any running builds and start the build for the synchronized pull-request
 * @method pullRequestSync
 * @param  {Object}       options
 * @param  {String}       options.eventId    Unique ID for this GitHub event
 * @param  {String}       options.jobId      Identifier for the Job
 * @param  {String}       options.name       Name of the job (PR-1)
 * @param  {Hapi.request} request Request from user
 * @param  {Hapi.reply}   reply   Reply to user
 */
function pullRequestSync(options, request, reply) {
    const eventId = options.eventId;
    const jobId = options.jobId;
    const name = options.name;

    async.waterfall([
        // Lookup all the builds for the jobId
        (next) => build.getBuildsForJobId({ jobId }, next),
        // Stop all builds for the jobId
        (builds, next) => {
            async.each(
                builds,
                (buildObj, cb) => {
                    // TODO: add in stopping of job
                    cb();
                },
                next
            );
        },
        // Log it
        (next) => {
            request.log(['webhook-github', eventId, jobId], `${name} stopped`);
            next();
        },
        // Create new build for the jobId
        (next) => build.create({ jobId }, next),
        // Log it
        (buildObj, next) => {
            request.log(['webhook-github', eventId, jobId, buildObj.id], `${name} started `
                + `${buildObj.number}`);
            next();
        }
    ], (err) => {
        if (err) {
            return reply(boom.wrap(err));
        }
        request.log(['webhook-github', eventId, jobId], `${name} synced`);

        return reply().code(201);
    });
}

/**
 * Act on a Pull Request change (create, sync, close)
 *  - Opening a PR should sync the pipeline (creating the job) and start the new PR job
 *  - Syncing a PR should stop the existing PR job and start a new one
 *  - Closing a PR should stop the PR job and sync the pipeline (disabling the job)
 * @method pullRequestEvent
 * @param  {Hapi.request}       request Request from user
 * @param  {Hapi.reply}         reply   Reply to user
 */
function pullRequestEvent(request, reply) {
    const eventId = request.headers['x-github-delivery'];
    const payload = request.payload;
    const action = hoek.reach(payload, 'action');
    const prNumber = hoek.reach(payload, 'pull_request.number');
    const repository = hoek.reach(payload, 'pull_request.base.repo.ssh_url');
    const branch = hoek.reach(payload, 'pull_request.base.ref');
    const scmUrl = `${repository}#${branch}`;
    const sha = hoek.reach(payload, 'pull_request.head.sha');

    request.log(['webhook-github', eventId], `PR #${prNumber} ${action} for ${scmUrl}`);

    // Possible actions
    // "opened", "closed", "reopened", "synchronize",
    // "assigned", "unassigned", "labeled", "unlabeled", "edited"
    pipeline.sync({ scmUrl }, (err, data) => {
        if (err) {
            return reply(boom.wrap(err));
        }
        if (!data) {
            return reply(boom.notFound('Pipeline does not exist'));
        }
        const pipelineId = pipeline.generateId({ scmUrl });
        const name = `PR-${prNumber}`;
        const jobId = job.generateId({ pipelineId, name });

        switch (action) {
        case 'opened':
        case 'reopened':
            return pullRequestOpened({
                eventId,
                pipelineId,
                jobId,
                name,
                sha
            }, request, reply);

        case 'synchronize':
            return pullRequestSync({ eventId, pipelineId, jobId, name }, request, reply);

        case 'closed':
            return pullRequestClosed({ eventId, pipelineId, jobId, name }, request, reply);

        default:
            // Ignore other actions
            return reply().code(204);
        }
    });
}

/**
 * GitHub Webhook Plugin
 *  - Validates that the event came from GitHub
 *  - Opening a PR should sync the pipeline (creating the job) and start the new PR job
 *  - Syncing a PR should stop the existing PR job and start a new one
 *  - Closing a PR should stop the PR job and sync the pipeline (disabling the job)
 * @method github
 * @param  {Hapi.Server}    server
 * @param  {Object}         options
 * @param  {String}         options.secret    GitHub Webhook secret to sign payloads with
 * @param  {Function}       next
 */
module.exports = (server, options) => {
    // Do some silly setup of stuff
    pipeline = new Models.Pipeline(server.settings.app.datastore);
    job = new Models.Job(server.settings.app.datastore);
    build = new Models.Build(server.settings.app.datastore, server.settings.app.executor);

    // Register the hook interface
    server.register(githubWebhooks);
    // Add the auth strategy
    server.auth.strategy('githubwebhook', 'githubwebhook', {
        secret: options.secret
    });

    // Now use it
    return {
        method: 'POST',
        path: '/webhooks/github',
        config: {
            description: 'Handle events from GitHub',
            notes: 'Acts on pull request, pushes, comments, etc.',
            tags: ['api', 'github', 'webhook'],
            auth: {
                strategies: ['githubwebhook'],
                payload: 'required'
            },
            handler: (request, reply) => {
                const eventType = request.headers['x-github-event'];
                const eventId = request.headers['x-github-delivery'];

                request.log(['webhook-github', eventId], `Received event ${eventType}`);

                switch (eventType) {
                case 'ping':
                    return reply().code(204);
                case 'pull_request':
                    return pullRequestEvent(request, reply);
                default:
                    return reply(boom.badRequest(`Event ${eventType} not supported`));
                }
            }
        }
    };
};