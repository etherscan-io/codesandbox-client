import { dirname } from 'path';

import {
  getDirectoryPath,
  getModulePath,
} from '@codesandbox/common/lib/sandbox/modules';
import {
  Directory,
  Module,
  Sandbox,
  SandboxFs,
} from '@codesandbox/common/lib/types';
import { getAbsoluteDependencies } from '@codesandbox/common/lib/utils/dependencies';
import { getGlobal } from '@codesandbox/common/lib/utils/global';
import { protocolAndHost } from '@codesandbox/common/lib/utils/url-generator';
import { blocker } from 'app/utils/blocker';
import { json } from 'overmind';

import { EXTENSIONS_LOCATION } from '../constants';
import { getTypeFetcher } from '../extensionHostWorker/common/type-downloader';
import { mkdir, rename, rmdir, unlink, writeFile } from './utils';

const global = getGlobal() as Window & { BrowserFS: any };

const browserFs = global.BrowserFS.BFSRequire('fs');
const SERVICE_URL = 'https://ata-fetcher.cloud/api/v5/typings';

let lastMTime = new Date(0);

declare global {
  interface Window {
    BrowserFS: any;
  }
}

type SandboxFsSyncOptions = {
  getSandboxFs: () => SandboxFs;
};

class SandboxFsSync {
  private options: SandboxFsSyncOptions;
  private types: any;
  private typesInfo: Promise<any>;
  private initializingWorkers = blocker<void>();
  private workersInitializedCount = 0;
  public initialize(options: SandboxFsSyncOptions) {
    this.options = options;
    self.addEventListener('message', evt => {
      // We do not want to send initial sandbox until
      // all 3 filesystems are running
      if (this.initializingWorkers.isResolved()) {
        if (evt.data.$type === 'sync-types') {
          this.syncDependencyTypings();
        }

        if (evt.data.$type === 'sync-sandbox') {
          this.syncSandbox();
        }
      } else if (evt.data.$type === 'sync-sandbox') {
        this.workersInitializedCount++;

        if (this.workersInitializedCount === 3) {
          this.initializingWorkers.resolve();
        }
      }
    });

    return new Promise((resolve, reject) => {
      window.BrowserFS.configure(
        {
          fs: 'MountableFileSystem',
          options: {
            '/': { fs: 'InMemory', options: {} },
            '/sandbox': {
              fs: 'CodeSandboxEditorFS',
              options: {
                api: {
                  getSandboxFs: options.getSandboxFs,
                },
              },
            },
            '/sandbox/node_modules': {
              fs: 'CodeSandboxFS',
              options: getTypeFetcher().options,
            },
            '/vscode': {
              fs: 'LocalStorage',
            },
            '/home': {
              fs: 'LocalStorage',
            },
            '/extensions': {
              fs: 'BundledHTTPRequest',
              options: {
                index: EXTENSIONS_LOCATION + '/extensions/index.json',
                baseUrl: EXTENSIONS_LOCATION + '/extensions',
                bundle: EXTENSIONS_LOCATION + '/bundles/main.min.json',
                logReads: process.env.NODE_ENV === 'development',
              },
            },
            '/extensions/custom-theme': {
              fs: 'InMemory',
            },
          },
        },
        async e => {
          if (e) {
            reject(e);
          } else {
            resolve();
          }
        }
      );
    });
  }

  public create(sandbox: Sandbox): SandboxFs {
    const sandboxFs = {};

    sandbox.modules.forEach(m => {
      const path = getModulePath(sandbox.modules, sandbox.directories, m.id);
      if (path) {
        m.path = path;
        sandboxFs[path] = {
          ...m,
          path,
          type: 'file',
        };
      }
    });

    sandbox.directories.forEach(d => {
      const path = getDirectoryPath(sandbox.modules, sandbox.directories, d.id);

      // If this is a single directory with no children
      if (!Object.keys(sandboxFs).some(p => dirname(p) === path)) {
        d.path = path;
        sandboxFs[path] = { ...d, path, type: 'directory' };
      }
    });

    this.sync();

    return sandboxFs;
  }

  public writeFile(fs: SandboxFs, module: Module) {
    writeFile(fs, json(module));

    this.send('write-file', module);

    if (module.title === 'package.json') {
      this.syncDependencyTypings();
    }
  }

  public rename(fs: SandboxFs, fromPath: string, toPath: string) {
    rename(fs, fromPath, toPath);
    this.send('rename', {
      fromPath,
      toPath,
    });
  }

  public rmdir(fs: SandboxFs, directory: Directory) {
    rmdir(fs, directory);
    global.postMessage(
      {
        $broadcast: true,
        $type: 'rmdir',
        $data: directory,
      },
      protocolAndHost()
    );
  }

  public unlink(fs: SandboxFs, module: Module) {
    unlink(fs, module);
    global.postMessage(
      {
        $broadcast: true,
        $type: 'unlink',
        $data: module,
      },
      protocolAndHost()
    );
  }

  public mkdir(fs: SandboxFs, directory: Directory) {
    mkdir(fs, json(directory));
    global.postMessage(
      {
        $broadcast: true,
        $type: 'mkdir',
        $data: directory,
      },
      protocolAndHost()
    );
  }

  private syncSandbox() {
    // eslint-disable-next-line
    console.log('## SYNCING SANDBOX AND TYPINGS WITH WORKERS');
    global.postMessage(
      {
        $broadcast: true,
        $type: 'sandbox-fs',
        $data: json(this.options.getSandboxFs()),
      },
      protocolAndHost()
    );
  }

  private async sync() {
    await this.initializingWorkers.promise;

    this.syncSandbox();

    try {
      await this.syncDependencyTypings();
    } catch (error) {
      // Might not be a filesystem ready yet
      // console.log('ERROR SYNCING', error);
    }
  }

  private send(type: string, data: any) {
    global.postMessage(
      {
        $broadcast: true,
        $type: type,
        $data: json(data),
      },
      protocolAndHost()
    );
  }

  private async syncDependencyTypings() {
    const syncDetails = await this.getDependencyTypingsSyncDetails();

    if (syncDetails) {
      this.types = await this.getDependencyTypings(
        syncDetails.packageJsonContent,
        syncDetails.autoInstall
      );
      this.sendTypes();
    }
  }

  private async getDependencyTypingsSyncDetails(): Promise<{
    packageJsonContent: string;
    autoInstall: boolean;
  }> {
    return new Promise((resolve, reject) => {
      try {
        browserFs.stat('/sandbox/package.json', (packageJsonError, stat) => {
          if (packageJsonError) {
            reject(packageJsonError);
            return;
          }

          if (stat.mtime.toString() !== lastMTime.toString()) {
            lastMTime = stat.mtime;

            browserFs.readFile(
              '/sandbox/package.json',
              async (packageJsonReadError, rv) => {
                if (packageJsonReadError) {
                  reject(packageJsonReadError);
                  return;
                }

                browserFs.stat(
                  '/sandbox/tsconfig.json',
                  (tsConfigError, result) => {
                    // If tsconfig exists we want to sync the types
                    resolve({
                      packageJsonContent: rv.toString(),
                      autoInstall: Boolean(tsConfigError) || !result,
                    });
                  }
                );
              }
            );
          }
        });
      } catch (e) {
        resolve(null);
        // Do nothing
      }
    });
  }

  private sendTypes() {
    global.postMessage(
      {
        $broadcast: true,
        $type: 'typings-sync',
        $data: this.types,
      },
      protocolAndHost()
    );
  }

  /**
   * Gets all entries of dependencies -> @types/ version
   */
  private getTypesInfo() {
    if (this.typesInfo) {
      return this.typesInfo;
    }

    this.typesInfo = fetch('https://unpkg.com/types-registry@latest/index.json')
      .then(x => x.json())
      .then(x => x.entries);

    return this.typesInfo;
  }

  private async getDependencyTypings(
    packageJSON: string,
    autoInstallTypes: boolean
  ) {
    try {
      const { dependencies = {}, devDependencies = {} } = JSON.parse(
        packageJSON
      );

      const totalDependencies = {
        '@types/jest': 'latest',
        ...dependencies,
        ...devDependencies,
      };

      if (autoInstallTypes) {
        const typeInfo = await this.getTypesInfo();
        Object.keys(totalDependencies).forEach(async dep => {
          if (
            !dep.startsWith('@types/') &&
            !totalDependencies[`@types/${dep}`] &&
            typeInfo[dep]
          ) {
            totalDependencies[`@types/${dep}`] = typeInfo[dep].latest;
          }
        });
      }

      const absoluteDependencies = await getAbsoluteDependencies(
        totalDependencies
      );

      const filesList = await Promise.all(
        Object.keys(absoluteDependencies).map(async depName => {
          const depVersion = absoluteDependencies[depName];

          try {
            const fetchRequest = await fetch(
              `${SERVICE_URL}/${depName}@${depVersion}.json`
            );

            if (!fetchRequest.ok) {
              throw new Error('Fetch error');
            }

            const { files } = await fetchRequest.json();

            return files;
          } catch (e) {
            if (process.env.NODE_ENV === 'development') {
              console.warn('Trouble fetching types for ' + depName);
            }

            return {};
          }
        })
      );

      return filesList.reduce((aggr, files) => ({ ...aggr, ...files }), {});
    } catch (e) {
      /* ignore */
      return Promise.resolve({});
    }
  }
}

export default new SandboxFsSync();
