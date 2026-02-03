/**
 * Config command implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, setConfigValue } from '../config.js';

export interface ConfigOptions {
    show?: boolean;
    set?: string;
    init?: boolean;
}

export interface ConfigResponse {
    success: boolean;
    message: string;
    config?: any;
    config_path?: string;
}

/**
 * Manage configuration
 */
export async function manageConfig(options: ConfigOptions): Promise<ConfigResponse> {
    const configPath = path.join(os.homedir(), '.notes-search', 'config.json');

    if (options.init) {
        // Initialize with defaults
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        if (fs.existsSync(configPath)) {
            return {
                success: false,
                message: 'Configuration already exists. Use --set to modify values.',
                config_path: configPath,
            };
        }

        // Save default config
        saveConfig({});

        return {
            success: true,
            message: 'Configuration initialized with defaults.',
            config: loadConfig(),
            config_path: configPath,
        };
    }

    if (options.set) {
        // Parse key=value
        const [keyPath, ...valueParts] = options.set.split('=');
        const value = valueParts.join('='); // Handle values containing =

        if (!keyPath || value === undefined) {
            throw new Error('Invalid format. Use: --set key=value');
        }

        setConfigValue(keyPath, value);

        return {
            success: true,
            message: `Set ${keyPath} = ${value}`,
            config: loadConfig(),
            config_path: configPath,
        };
    }

    if (options.show) {
        const config = loadConfig();

        return {
            success: true,
            message: 'Current configuration:',
            config,
            config_path: fs.existsSync(configPath) ? configPath : '(using defaults)',
        };
    }

    // Default: show config
    return manageConfig({ show: true });
}
