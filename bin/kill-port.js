#!/usr/bin/env node
import { execSync } from 'node:child_process';

const arg = process.argv[2];
let port = arg;

// If arg matches an env var name, use its value.
if (arg && process.env[arg]) {
	port = process.env[arg];
}

// Fallback logic if port is not determined/valid number
if (!port || !/^\d+$/.test(port)) {
	if (arg === 'ROUTER_PORT' || arg === 'PORT') {
		port = process.env.ROUTER_PORT || process.env.PORT || '3100';
	} else {
		// Default to API_PORT or 3101
		port = process.env.API_PORT || '3101';
	}
}

try {
	const pidString = execSync(`lsof -t -i :${port}`, { encoding: 'utf8' }).trim();
	if (pidString) {
		const pids = pidString.split('\n');
		for (const pid of pids) {
			if (pid) {
				console.log(`[kill-port] Killing process ${pid} listening on port ${port}...`);
				process.kill(Number(pid), 'SIGKILL');
			}
		}
	}
} catch {
	// lsof exits with 1 if no process matches, which throws. Safe to ignore.
}
