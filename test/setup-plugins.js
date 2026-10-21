/*
  Loaded with `node --import` is not needed: each test file imports this once.
  core's workers use the Node plugin registry for this checkout: every
  @engine9/schemas plugin plus this package (package.json "engine9.pluginPackages").
*/
import { ensureNodePluginRegistry } from '@engine9/core/plugins/node';

ensureNodePluginRegistry({ cwd: new URL('..', import.meta.url).pathname });
