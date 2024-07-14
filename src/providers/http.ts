import invariant from 'tiny-invariant';
import { exec } from 'child_process';
import { spawn } from 'child_process';

import logger from '../logger';
import { fetchWithCache } from '../cache';
import { REQUEST_TIMEOUT_MS } from './shared';
import { getNunjucksEngine, safeJsonStringify } from '../util';
import axios from 'axios';
import { promisify } from 'util';

import type {
  ApiProvider,
  CallApiContextParams,
  ProviderOptions,
  ProviderResponse,
} from '../types.js';

const execAsync = promisify(exec);

export class HttpProvider implements ApiProvider {
  url: string;
  config: any;
  responseParser: (data: any) => ProviderResponse;
  useRunningDesigner: boolean;

  constructor(url: string, options: ProviderOptions, useRunningDesigner : boolean) {
    this.url = url;
    this.config = options.config;
    this.responseParser = createResponseParser(this.config.responseParser);
    this.useRunningDesigner = useRunningDesigner || false;
  }

  id(): string {
    return this.url;
  }

  toString(): string {
    return `[HTTP Provider ${this.url}]`;
  }

  private async isProcessRunning(processName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${processName}"`);
      return stdout.toLowerCase().includes(processName.toLowerCase());
    } catch (error) {
      logger.error(`Error checking if ${processName} is running:`, error);
      return false;
    }
  }

  private startDesigner(): Promise<void> {
    return new Promise((resolve, reject) => {
      const designerProcess = spawn(
        'C:\\workspace\\dces\\branches\\Features\\bachelorArbeit\\GUI.Designer\\bin\\x64\\Debug\\net472\\Designer.exe',
        ['-assistentDebug'],
        {
          detached: true,
          stdio: 'ignore',
          shell: true
        }
      );

      designerProcess.on('error', (err) => {
        logger.error('Error starting Designer.exe:', err);
        reject(err);
      });

      // We consider the process started successfully once it spawns
      designerProcess.on('spawn', () => {
        logger.info('Designer.exe started successfully');
        resolve();
      });

      // Unref the child process so it can run independently of its parent
      designerProcess.unref();
    });
  }

  private async closeDesigner(): Promise<void> {
    try {
      await execAsync('taskkill /F /IM Designer.exe');
    } catch (error) {
      logger.error('Error closing Designer.exe:', error);
    }
  }

  private async waitForDesignerReady(maxAttempts = 10, interval = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get('http://localhost:9000/api/smartassistent');
        if (response.data === 'It works!') {
          return;
        }
      } catch (error) {
        // Ignore errors and continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error('Designer.exe did not become ready in time');
  }


  async callApi(prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    // Check if Designer.exe is running
   if (!this.useRunningDesigner) {
      // Check if Designer.exe is running
      if (await this.isProcessRunning('Designer.exe')) {
        return {
          error: 'Designer.exe is already running. Please close it before proceeding.',
        };
      }
    }

    try {
      if (!this.useRunningDesigner) {
        await this.startDesigner();
      }

      // Wait for Designer.exe to be ready
      await this.waitForDesignerReady();

      // Render all nested strings
      const nunjucks = getNunjucksEngine();
      const stringifiedConfig = safeJsonStringify(this.config);
      const renderedConfig: { method: string; headers: Record<string, string>; body: any } =
        JSON.parse(
          nunjucks.renderString(stringifiedConfig, {
            prompt,
            ...context?.vars,
          }),
        );

      const method = renderedConfig.method || 'POST';
      const headers = renderedConfig.headers || { 'Content-Type': 'application/json' };
      invariant(typeof method === 'string', 'Expected method to be a string');
      invariant(typeof headers === 'object', 'Expected headers to be an object');

      logger.debug(`Calling HTTP provider: ${this.url} with config: ${stringifiedConfig}`);
      let response;
      try {
        response = await fetchWithCache(
          this.url,
          {
            method,
            headers,
            body: JSON.stringify(renderedConfig.body),
          },
          REQUEST_TIMEOUT_MS,
          'json',
        );
      } catch (err) {
        return {
          error: `HTTP call error: ${String(err)}`,
        };
      }
      logger.debug(`\tHTTP response: ${JSON.stringify(response.data)}`);

      return this.responseParser(response.data);
    } finally {
      // Close Designer.exe regardless of the outcome
         if (!this.useRunningDesigner) {
           // Close Designer.exe regardless of the outcome
           await this.closeDesigner();
         }
    }
  }
}
function createResponseParser(parser: any): (data: any) => ProviderResponse {
  if (typeof parser === 'function') {
    return parser;
  }
  if (typeof parser === 'string') {
    return new Function('json', `return ${parser}`) as (data: any) => ProviderResponse;
  }
  return (data) => ({ output: data });
}
