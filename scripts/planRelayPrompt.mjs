import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function bashPermissions(config) {
  const permissions = config?.agent?.executor?.permission?.bash;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new Error('executor config is missing agent.executor.permission.bash');
  }
  return permissions;
}

function renderPattern(pattern, permissions) {
  const optionalSuffix = ' *';
  if (pattern.endsWith(optionalSuffix)) {
    const command = pattern.slice(0, -optionalSuffix.length);
    if (permissions[command] === 'allow') return `${command} with optional arguments`;
    return `${command} with arguments`;
  }
  return pattern;
}

export function formatAllowedCommands(config) {
  const permissions = bashPermissions(config);
  const allowed = Object.entries(permissions)
    .filter(([pattern, decision]) => decision === 'allow' && pattern !== '*')
    .map(([pattern]) => pattern);

  if (allowed.length === 0) {
    throw new Error('executor config contains no allowed bash commands');
  }

  const rendered = [];
  for (const pattern of allowed) {
    if (permissions[`${pattern} *`] === 'allow') {
      rendered.push(`${pattern} with optional arguments`);
      continue;
    }
    if (pattern.endsWith(' *') && permissions[pattern.slice(0, -2)] === 'allow') continue;
    rendered.push(renderPattern(pattern, permissions));
  }
  return rendered.join('; ');
}

function main(argv) {
  const [configPath] = argv;
  if (!configPath) {
    console.error('Usage: planRelayPrompt.mjs <executor-config.json>');
    return 2;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    console.log(formatAllowedCommands(config));
    return 0;
  } catch (error) {
    console.error(`Plan Relay prompt: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
