import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const cwd = realpathSync(resolve(input.cwd ?? process.cwd()));
const eventsPath = resolve(cwd, '.swarm-delegation-events.jsonl');
const reviewPath = resolve(cwd, '.swarm-delegation-review.json');
const documentationExtensions = new Set(['.adoc', '.md', '.mdx', '.rst', '.txt']);

function assertContract(condition, message) {
	if (!condition) throw new Error(message);
}

function invocationIdentity() {
	assertContract(
		typeof input.session_id === 'string' && input.session_id,
		'missing parent session id',
	);
	assertContract(
		typeof input.agent_id === 'string' && /^[a-zA-Z0-9_-]+$/.test(input.agent_id),
		'missing or invalid child agent id',
	);
	return {
		invocationId: `${input.session_id}:${input.agent_id}`,
		parentSessionId: input.session_id,
		agentId: input.agent_id,
	};
}

function startPathFor(agentId) {
	return resolve(cwd, `.swarm-delegation-${agentId}.start`);
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
		contract.maxTurns === undefined,
		'contract maxTurns is unsupported; swarm-doc-editor has a fixed 12-turn limit',
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

function extractContract(text) {
	const matches = [
		...text.matchAll(/<swarm-delegation-contract>\s*([\s\S]*?)\s*<\/swarm-delegation-contract>/g),
	];
	assertContract(matches.length === 1, 'expected exactly one <swarm-delegation-contract> JSON');
	const contract = JSON.parse(matches[0][1]);
	validateContractShape(contract);
	return contract;
}

function collectAgentCalls(line, agentCalls, toolResults) {
	let entry;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	const content = entry?.message?.content;
	if (!Array.isArray(content)) return;
	for (const item of content) {
		if (item?.type === 'tool_result' && typeof item.tool_use_id === 'string') {
			toolResults.set(item.tool_use_id, JSON.stringify(item.content));
		}
		if (
			item?.type === 'tool_use' &&
			item.name === 'Agent' &&
			item.input?.subagent_type === 'swarm-doc-editor' &&
			typeof item.input.prompt === 'string'
		) {
			agentCalls.push({ id: item.id, prompt: item.input.prompt });
		}
	}
}

function contractFromPendingAgentTool() {
	assertContract(
		input.transcript_path && existsSync(input.transcript_path),
		'missing parent transcript',
	);
	const agentCalls = [];
	const toolResults = new Map();
	for (const line of readFileSync(input.transcript_path, 'utf8').split('\n')) {
		if (line) collectAgentCalls(line, agentCalls, toolResults);
	}
	const correlated = agentCalls.filter((call) =>
		toolResults.get(call.id)?.includes(`agentId: ${input.agent_id}`),
	);
	const pending = agentCalls.filter((call) => !toolResults.has(call.id));
	const candidates = correlated.length > 0 ? correlated : pending;
	assertContract(
		candidates.length === 1,
		`expected one trusted swarm-doc-editor Agent call for this child, found ${candidates.length}`,
	);
	return extractContract(candidates[0].prompt);
}

function readStart(path) {
	const start = JSON.parse(readFileSync(path, 'utf8'));
	validateContractShape(start.contract);
	return start;
}

function assertUniqueContract(contractId, invocationId, parentSessionId) {
	for (const name of readdirSync(cwd)) {
		if (!/^\.swarm-delegation-[a-zA-Z0-9_-]+\.start$/.test(name)) continue;
		try {
			const existing = readStart(resolve(cwd, name));
			if (
				existing.parentSessionId === parentSessionId &&
				existing.invocationId !== invocationId &&
				existing.contract.id === contractId
			) {
				throw new Error(`duplicate contract id in parent session: ${contractId}`);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('duplicate contract id')) throw error;
		}
	}
}

function loadInvocation() {
	const identity = invocationIdentity();
	const startPath = startPathFor(identity.agentId);
	if (existsSync(startPath)) {
		const start = readStart(startPath);
		assertContract(
			start.invocationId === identity.invocationId,
			'child start belongs to another invocation',
		);
		return { ...start, startPath };
	}
	const contract = contractFromPendingAgentTool();
	assertUniqueContract(contract.id, identity.invocationId, identity.parentSessionId);
	const start = { ...identity, contract, startedAt: Date.now() };
	writeFileSync(startPath, `${JSON.stringify(start)}\n`, { flag: 'wx', mode: 0o600 });
	return { ...start, startPath };
}

function repositoryPath(path) {
	assertContract(typeof path === 'string' && path, 'missing tool file path');
	const lexical = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	const lexicalRelative = relative(cwd, lexical);
	if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
		throw new Error(`path escapes worktree: ${path}`);
	}
	let absolute;
	try {
		absolute = realpathSync(lexical);
	} catch {
		throw new Error(`path does not resolve to an existing file: ${path}`);
	}
	const repoRelative = relative(cwd, absolute);
	if (repoRelative.startsWith('..') || isAbsolute(repoRelative)) {
		throw new Error(`path escapes worktree through symlink: ${path}`);
	}
	return { absolute, repoRelative };
}

function appendObservation(invocation, outcome, reason) {
	appendFileSync(
		eventsPath,
		`${JSON.stringify({
			invocationId: invocation?.invocationId ?? 'invalid-invocation',
			contractId: invocation?.contract?.id ?? 'invalid-contract',
			parentRunId: process.env.SWARM_PARENT_RUN_ID || undefined,
			parentSessionId: invocation?.parentSessionId ?? input.session_id,
			phase: process.env.SWARM_PIPELINE_PHASE ?? 'unknown',
			agent: 'swarm-doc-editor',
			model: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? 'haiku',
			delegationType: 'documentation-edit',
			allowedPaths: invocation?.contract?.allowedPaths ?? [],
			outcome,
			reason,
		})}\n`,
	);
}

function validate() {
	let invocation;
	try {
		invocation = loadInvocation();
		const allowed = new Set(
			invocation.contract.allowedPaths.map((path) => {
				const resolvedPath = repositoryPath(path);
				if (!documentationExtensions.has(extname(resolvedPath.repoRelative).toLowerCase())) {
					throw new Error(`non-documentation path: ${path}`);
				}
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
		if (!allowed.has(requested)) {
			throw new Error(`tool path is outside allowedPaths: ${input.tool_input?.file_path}`);
		}
	} catch (error) {
		appendObservation(invocation, 'rejected', error.message);
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
	let invocation;
	try {
		invocation = loadInvocation();
	} catch (error) {
		process.stderr.write(`SWARM delegation record skipped: ${error.message}\n`);
		return;
	}
	if (existsSync(eventsPath)) {
		const duplicate = readFileSync(eventsPath, 'utf8')
			.split('\n')
			.some((line) => {
				try {
					const event = JSON.parse(line);
					return event.invocationId === invocation.invocationId && event.outcome === 'completed';
				} catch {
					return false;
				}
			});
		if (duplicate) return;
	}
	const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
	if (input.transcript_path && existsSync(input.transcript_path)) {
		for (const line of readFileSync(input.transcript_path, 'utf8').split('\n')) {
			try {
				addUsage(JSON.parse(line), totals);
			} catch {}
		}
	}
	appendFileSync(
		eventsPath,
		`${JSON.stringify({
			invocationId: invocation.invocationId,
			contractId: invocation.contract.id,
			parentRunId: process.env.SWARM_PARENT_RUN_ID || undefined,
			parentSessionId: invocation.parentSessionId,
			phase: process.env.SWARM_PIPELINE_PHASE ?? 'unknown',
			agent: 'swarm-doc-editor',
			model: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? 'haiku',
			delegationType: 'documentation-edit',
			allowedPaths: invocation.contract.allowedPaths,
			durationMs: Math.max(0, Date.now() - invocation.startedAt),
			usage: totals.inputTokens + totals.outputTokens > 0 ? totals : undefined,
			outcome: 'completed',
		})}\n`,
	);
}

function validateReview() {
	if (!existsSync(eventsPath)) return;
	const parentSessionId = input.session_id;
	const completed = readFileSync(eventsPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const event = JSON.parse(line);
				return event.outcome === 'completed' && event.parentSessionId === parentSessionId
					? [event]
					: [];
			} catch {
				return [];
			}
		});
	if (completed.length === 0) return;
	try {
		const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
		if (!Array.isArray(review.delegations)) throw new Error('delegations must be an array');
		for (const event of completed) {
			const disposition = review.delegations.find(
				(item) =>
					item?.invocationId === event.invocationId && item?.contractId === event.contractId,
			);
			if (!['accepted', 'reworked'].includes(disposition?.disposition) || !disposition?.note) {
				throw new Error(
					`missing fresh accepted/reworked disposition and note for ${event.invocationId}`,
				);
			}
		}
	} catch (error) {
		process.stderr.write(
			`SWARM primary review is incomplete: ${error.message}. Write .swarm-delegation-review.json with invocationId, contractId, disposition, and note for every current child.\n`,
		);
		process.exit(2);
	}
}

if (process.argv[2] === 'validate') validate();
else if (process.argv[2] === 'record') record();
else if (process.argv[2] === 'review') validateReview();
else throw new Error('expected validate, record, or review');
