import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Community node packages for the node API compatibility guard, one per
 * `n8n.n8nNodesApiVersion` shape the guard distinguishes. They are generated
 * rather than checked in as directories: the whole fixture set is readable
 * here, and no fixture ever needs a build step.
 *
 * Every package ships one trivial node. Its module writes an import marker
 * file into the n8n user folder when required, so a test can prove that a
 * rejected or skipped package's code never ran.
 */
export interface FixturePackage {
	/** Stable key for tests; the npm name is `n8n-nodes-compat-<key>`. */
	key: 'legacy' | 'v1' | 'v3' | 'malformed' | 'ondisk';
	name: string;
	version: string;
	/** Node type name without the package prefix. */
	nodeName: string;
	/**
	 * Value written to `n8n.n8nNodesApiVersion`. `undefined` leaves the field
	 * out entirely (a legacy package), any other value is written verbatim.
	 */
	nodesApiVersion: number | string | undefined;
	/** What the runtime should conclude about the declared version. */
	requirement: { kind: 'level'; level: number } | { kind: 'malformed' };
}

const fixturePackage = (
	key: FixturePackage['key'],
	version: string,
	nodesApiVersion: FixturePackage['nodesApiVersion'],
	requirement: FixturePackage['requirement'],
): FixturePackage => ({
	key,
	name: `n8n-nodes-compat-${key}`,
	version,
	nodeName: `compat${key.charAt(0).toUpperCase()}${key.slice(1)}`,
	nodesApiVersion,
	requirement,
});

/** Packages a test can ask n8n to install. */
export const INSTALLABLE_PACKAGES = {
	legacy: fixturePackage('legacy', '1.0.0', undefined, { kind: 'level', level: 1 }),
	v1: fixturePackage('v1', '1.0.0', 1, { kind: 'level', level: 1 }),
	v3: fixturePackage('v3', '1.0.0', 3, { kind: 'level', level: 3 }),
	// Not a positive integer, and not a `major.minor` string either, so it stays
	// malformed if minor levels ever become valid.
	malformed: fixturePackage('malformed', '1.0.0', 'not-a-level', { kind: 'malformed' }),
} as const satisfies Record<string, FixturePackage>;

/**
 * A second release of the legacy package that moves to node API level 3, so
 * `latest` of `n8n-nodes-compat-legacy` is an update a 2.x instance must refuse.
 */
export const LEGACY_PACKAGE_V3_UPDATE = fixturePackage('legacy', '2.0.0', 3, {
	kind: 'level',
	level: 3,
});

/** Level 3 package for the startup guard: dropped onto disk, never installed. */
export const ON_DISK_PACKAGE = fixturePackage('ondisk', '1.0.0', 3, { kind: 'level', level: 3 });

/** Publish order matters: the last version published becomes `latest`. */
export const PUBLISHED_PACKAGES: readonly FixturePackage[] = [
	INSTALLABLE_PACKAGES.legacy,
	INSTALLABLE_PACKAGES.v1,
	INSTALLABLE_PACKAGES.v3,
	INSTALLABLE_PACKAGES.malformed,
	ON_DISK_PACKAGE,
	LEGACY_PACKAGE_V3_UPDATE,
];

/** Directory inside the n8n user folder where fixture nodes leave import markers. */
export const IMPORT_MARKER_DIR = '.n8n/community-package-imports';

export const importMarkerName = (pkg: FixturePackage): string => `${pkg.name}@${pkg.version}`;

/** Type of the node the package registers, e.g. `n8n-nodes-compat-v1.compatV1`. */
export const nodeType = (pkg: FixturePackage): string => `${pkg.name}.${pkg.nodeName}`;

function nodeSource(pkg: FixturePackage): string {
	const className = `${pkg.nodeName.charAt(0).toUpperCase()}${pkg.nodeName.slice(1)}`;
	const displayName = `Compat ${pkg.key} ${pkg.version}`;
	return `'use strict';
// Import marker: proves to the test suite that n8n loaded this module. The
// folder is resolved the way n8n resolves its user folder.
const fs = require('node:fs');
const path = require('node:path');
const userFolder = process.env.N8N_USER_FOLDER ?? process.env.HOME ?? process.cwd();
const markerDir = path.join(userFolder, ${JSON.stringify(IMPORT_MARKER_DIR)});
fs.mkdirSync(markerDir, { recursive: true });
fs.writeFileSync(path.join(markerDir, ${JSON.stringify(importMarkerName(pkg))}), new Date().toISOString());

class ${className} {
	constructor() {
		this.description = {
			displayName: ${JSON.stringify(displayName)},
			name: ${JSON.stringify(pkg.nodeName)},
			group: ['transform'],
			version: 1,
			description: 'Node API compatibility fixture',
			defaults: { name: ${JSON.stringify(displayName)} },
			inputs: ['main'],
			outputs: ['main'],
			properties: [],
		};
	}

	async execute() {
		return [this.getInputData()];
	}
}

module.exports = { ${className} };
`;
}

function packageJson(pkg: FixturePackage, nodeFile: string): string {
	const n8n: Record<string, unknown> = { nodes: [nodeFile] };
	if (pkg.nodesApiVersion !== undefined) n8n.n8nNodesApiVersion = pkg.nodesApiVersion;
	return JSON.stringify(
		{
			name: pkg.name,
			version: pkg.version,
			description: `Node API compatibility fixture (${pkg.key})`,
			license: 'MIT',
			keywords: ['n8n-community-node-package'],
			files: ['dist'],
			n8n,
		},
		null,
		2,
	);
}

/**
 * Writes the package to `<root>/<name>-<version>` and returns that directory,
 * ready for `npm pack` or for copying straight into `~/.n8n/nodes/node_modules`.
 */
export async function writeFixturePackage(root: string, pkg: FixturePackage): Promise<string> {
	const dir = join(root, `${pkg.name}-${pkg.version}`);
	const className = `${pkg.nodeName.charAt(0).toUpperCase()}${pkg.nodeName.slice(1)}`;
	const nodeFile = `dist/${className}.node.js`;
	await mkdir(join(dir, 'dist'), { recursive: true });
	await writeFile(join(dir, 'package.json'), packageJson(pkg, nodeFile));
	await writeFile(join(dir, nodeFile), nodeSource(pkg));
	return dir;
}
