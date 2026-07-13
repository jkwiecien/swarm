import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const cwd = resolve(input.cwd ?? process.cwd());
const eventsPath = resolve(cwd, '.swarm-delegation-events.jsonl');
const startPath = resolve(cwd, `.swarm-delegation-${input.agent_id ?? 'unknown'}.start`);
const documentationExtensions = new Set(['.adoc', '.md', '.mdx', '.rst', '.txt']);

function strings(value, found = []) {
	if (typeof value === 'string') found.push(value);
	else if (Array.isArray(value)) for (const item of value) strings(item, found);
	else if (value && typeof value === 'object')
		for (const item of Object.values(value)) strings(item, found);
	return found;
}

function readTranscript() {
	if (!input.transcript_path || !existsSync(input.transcript_path)) return [];
	return readFileSync(input.transcript_path, 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return strings(JSON.parse(line));
			} catch {
				return [];
			}
		});
}

function assertContract(condition, message) {
	if (!condition) throw new Error(message);
}

function validateContractShape(contract) {
	assertContract(
		contract.version === 1 && contract.delegationType === 'documentation-edit',
		'unsupported delegation contract version or type',
	);
	assertContract(
		contract.agent === 'swarm-doc-editor' && contract.reviewRequired === true,
		'contract must name swarm-doc-editor and require primary review',
	);
	assertContract(
		['id', 'task', 'expectedArtifact'].every(
			(key) => typeof contract[key] === 'string' && contract[key].trim(),
		),
		'contract is missing required text fields',
	);
	assertContract(
		Array.isArray(contract.decidedFacts) && contract.decidedFacts.length > 0,
		'contract must include decidedFacts',
	);
	assertContract(
		Array.isArray(contract.prohibitedScope) && contract.prohibitedScope.length > 0,
		'contract must include prohibitedScope',
	);
	assertContract(
		contract.verification?.command && contract.verification?.evidence,
		'contract must include verification command and expected evidence',
	);
	assertContract(
		Number.isInteger(contract.maxTurns) && contract.maxTurns >= 1 && contract.maxTurns <= 12,
		'contract maxTurns must be between 1 and 12',
	);
	const minimum = Number.parseInt(process.env.SWARM_DELEGATION_MINIMUM_OPERATIONS ?? '3', 10);
	assertContract(
		Number.isInteger(contract.estimatedSemanticOperations) &&
			contract.estimatedSemanticOperations >= minimum,
		`delegation is below the minimum ${minimum} semantic operations`,
	);
	assertContract(
		Array.isArray(contract.allowedPaths) && contract.allowedPaths.length > 0,
		'contract must include allowedPaths',
	);
}

function contractFromTranscript() {
	const matches = readTranscript()
		.map((text) =>
			text.match(/<swarm-delegation-contract>\s*([\s\S]*?)\s*<\/swarm-delegation-contract>/),
		)
		.filter(Boolean);
	if (matches.length === 0) throw new Error('missing <swarm-delegation-contract> JSON');
	const contract = JSON.parse(matches.at(-1)[1]);
	validateContractShape(contract);
	return contract;
}

function repositoryPath(path) {
	const absolute = isAbsolute(path) ? normalize(path) : resolve(cwd, path);
	const repoRelative = relative(cwd, absolute);
	if (repoRelative.startsWith('..') || isAbsolute(repoRelative))
		throw new Error(`path escapes worktree: ${path}`);
	return { absolute, repoRelative };
}

function validate() {
	let contract;
	try {
		contract = contractFromTranscript();
		const allowed = new Set(
			contract.allowedPaths.map((path) => {
				const resolvedPath = repositoryPath(path);
				const dot = resolvedPath.repoRelative.lastIndexOf('.');
				const extension = dot === -1 ? '' : resolvedPath.repoRelative.slice(dot).toLowerCase();
				if (!documentationExtensions.has(extension))
					throw new Error(`non-documentation path: ${path}`);
				if (
					resolvedPath.repoRelative.startsWith('.claude/') ||
					resolvedPath.repoRelative.startsWith('.git/')
				) {
					throw new Error(`protected path: ${path}`);
				}
				return resolvedPath.absolute;
			}),
		);
		const requested = repositoryPath(input.tool_input?.file_path ?? '').absolute;
		if (!allowed.has(requested))
			throw new Error(`tool path is outside allowedPaths: ${input.tool_input?.file_path}`);
		if (!existsSync(startPath)) writeFileSync(startPath, String(Date.now()), { flag: 'wx' });
	} catch (error) {
		appendFileSync(
			eventsPath,
			`${JSON.stringify({
				contractId: contract?.id ?? 'invalid-contract',
				parentRunId: process.env.SWARM_PARENT_RUN_ID || undefined,
				parentSessionId: process.env.SWARM_PARENT_SESSION_ID || undefined,
				phase: process.env.SWARM_PIPELINE_PHASE ?? 'unknown',
				agent: 'swarm-doc-editor',
				model: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? 'haiku',
				delegationType: 'documentation-edit',
				allowedPaths: contract?.allowedPaths ?? [],
				outcome: 'rejected',
				reason: error.message,
			})}\n`,
		);
		process.stderr.write(`SWARM delegation rejected: ${error.message}\n`);
		process.exit(2);
	}
}

function addUsage(value, totals) {
	if (!value || typeof value !== 'object') return;
	if (Number.isFinite(value.input_tokens) && Number.isFinite(value.output_tokens)) {
		totals.inputTokens += value.input_tokens;
		totals.outputTokens += value.output_tokens;
		totals.cacheReadTokens += value.cache_read_input_tokens ?? 0;
		totals.cacheCreationTokens += value.cache_creation_input_tokens ?? 0;
		return;
	}
	for (const nested of Object.values(value)) addUsage(nested, totals);
}

function record() {
	let contract;
	try {
		contract = contractFromTranscript();
	} catch (error) {
		process.stderr.write(`SWARM delegation record skipped: ${error.message}\n`);
		return;
	}
	const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
	if (input.transcript_path && existsSync(input.transcript_path)) {
		for (const line of readFileSync(input.transcript_path, 'utf8').split('\n')) {
			try {
				addUsage(JSON.parse(line), totals);
			} catch {}
		}
	}
	const startedAt = existsSync(startPath)
		? Number.parseInt(readFileSync(startPath, 'utf8'), 10)
		: undefined;
	appendFileSync(
		eventsPath,
		`${JSON.stringify({
			contractId: contract.id,
			parentRunId: process.env.SWARM_PARENT_RUN_ID || undefined,
			parentSessionId: process.env.SWARM_PARENT_SESSION_ID || undefined,
			phase: process.env.SWARM_PIPELINE_PHASE ?? 'unknown',
			agent: 'swarm-doc-editor',
			model: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? 'haiku',
			delegationType: 'documentation-edit',
			allowedPaths: contract.allowedPaths,
			durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : undefined,
			usage: totals.inputTokens + totals.outputTokens > 0 ? totals : undefined,
			outcome: 'completed',
		})}\n`,
	);
}

function validateReview() {
	if (!existsSync(eventsPath)) return;
	const completedIds = readFileSync(eventsPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const event = JSON.parse(line);
				return event.outcome === 'completed' && typeof event.contractId === 'string'
					? [event.contractId]
					: [];
			} catch {
				return [];
			}
		});
	if (completedIds.length === 0) return;
	const reviewPath = resolve(cwd, '.swarm-delegation-review.json');
	try {
		const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
		if (!Array.isArray(review.delegations)) throw new Error('delegations must be an array');
		for (const contractId of new Set(completedIds)) {
			const disposition = review.delegations.find((item) => item?.contractId === contractId);
			if (!['accepted', 'reworked'].includes(disposition?.disposition) || !disposition?.note) {
				throw new Error(`missing accepted/reworked disposition and note for ${contractId}`);
			}
		}
	} catch (error) {
		process.stderr.write(
			`SWARM primary review is incomplete: ${error.message}. Write .swarm-delegation-review.json as {"delegations":[{"contractId":"...","disposition":"accepted"|"reworked","note":"..."}]}.\n`,
		);
		process.exit(2);
	}
}

if (process.argv[2] === 'validate') validate();
else if (process.argv[2] === 'record') record();
else if (process.argv[2] === 'review') validateReview();
else throw new Error('expected validate, record, or review');
