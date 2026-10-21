/*
  Example Cloudflare Worker: the gauge collector, queue consumer and cron.

  Deploy it as its own Worker (a sibling of the site, not part of core's). It
  shares the site's D1 database so the loader writes where core reads.

  Bindings (see wrangler.toml.example):
    DB              the engine9 D1 database, with gauge installed
    GAUGE_QUEUE     Queue: producer for the collector, consumer for queue()
    GAUGE_BUCKET    R2 bucket, optional: archive of every record (the "disk log")
  Secrets and vars:
    SESSION_SECRET  same value as the site, so a Core Session cookie is verified
    GAUGE_SALT      random string; keeps cookieless visitor ids stable
    GAUGE_SETTINGS  JSON, optional: settings used until D1 answers (streams, ...)
    GAUGE_BASE_PATH the path this Worker is routed at, e.g. /g

  Plugins: only those compiled into the bundle run, exactly as for core's own
  Worker. wrangler aliases `@engine9/core/plugins/site` to the engine9.plugins.js
  that `e9core build-plugins` writes from package.json "engine9.pluginPackages"
  (which must list @engine9/core-gauge).
*/
import PersonWorker from '@engine9/core/PersonWorker';
import pluginEntries, { packageVersions } from '@engine9/core/plugins/site';
import { createPluginRegistry } from '@engine9/core/pluginRegistry';
import { SqlApiKeyStore } from '@engine9/core/auth';
import { createGaugeHandlers } from '@engine9/core-gauge/cloudflare';

const plugins = pluginEntries ? createPluginRegistry(pluginEntries, { packageVersions: packageVersions || {} }) : null;

const gauge = createGaugeHandlers({
  makeWorker: (env) => new PersonWorker({ accountId: env.E9_ACCOUNT_ID || 'cloudflare', d1: env.DB, plugins }),
  // Lets a server call /send with an e9key_ that has the gauge:send scope.
  makeKeyStore: (worker) => new SqlApiKeyStore({ worker })
});

export default {
  fetch: (request, env, ctx) => gauge.fetch(request, env, ctx),
  queue: (batch, env, ctx) => gauge.queue(batch, env, ctx),
  scheduled: (event, env, ctx) => gauge.scheduled(event, env, ctx)
};
