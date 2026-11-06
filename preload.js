const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (a) => ipcRenderer.invoke(ch, a);
contextBridge.exposeInMainWorld('gc', Object.fromEntries(
  ['account', 'access', 'rejectKind', 'login', 'suggest', 'scan', 'ideas', 'prepare', 'draft', 'diff', 'test', 'ship', 'open', 'settings:get', 'settings:set', 'cache:get', 'cache:set', 'jobs:get', 'jobs:set', 'stop', 'prs', 'feedback', 'push', 'ci', 'stats', 'focus']
    .map(k => [k.replace(/:(.)/, (_, c) => c.toUpperCase()), call(k)])));

contextBridge.exposeInMainWorld('ev', { onStep: (f) => ipcRenderer.on('step', (_, d) => f(d)), onCkpt: (f) => ipcRenderer.on('ckpt', (_, d) => f(d)), onLog: (f) => ipcRenderer.on('log', (_, d) => f(d)) });
