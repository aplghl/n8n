import type { N8NStack } from 'n8n-containers/stack';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base } from '../base';
import {
	IMPORT_MARKER_DIR,
	PUBLISHED_PACKAGES,
	writeFixturePackage,
	type FixturePackage,
} from './fixture-packages';

export * from './fixture-packages';

export type InstallOutcome = 'accepted' | 'rejectedUnsupported' | 'rejectedMalformed';

/**
 * What the guard must decide for a package on an instance supporting
 * `supportedLevel`, so one spec runs against 2.x (level 1) and 3.x (level 3).
 */
export function expectedOutcome(pkg: FixturePackage, supportedLevel: number): InstallOutcome {
	if (pkg.requirement.kind === 'malformed') return 'rejectedMalformed';
	return pkg.requirement.level <= supportedLevel ? 'accepted' : 'rejectedUnsupported';
}

/** What the fixture packages left on the n8n instance's disk. */
export interface PackageDiskState {
	/** `~/.n8n/nodes/node_modules/<name>` exists. */
	directoryExists: boolean;
	/** `version` from that directory's package.json, if the directory exists. */
	installedVersion: string | undefined;
	/** Version the ledger `~/.n8n/nodes/package.json` records for the package. */
	ledgerVersion: string | undefined;
	/** Import markers (`<name>@<version>`) the fixture nodes wrote when loaded. */
	importMarkers: string[];
}

type StackContainer = N8NStack['containers'][number];

export class CommunityPackageDisk {
	private userFolder: Promise<string> | undefined;

	/**
	 * Takes a lookup rather than a container: `stack.replaceN8N()` swaps the
	 * main for a new container, and the checks must follow it.
	 */
	constructor(private readonly findMain: () => StackContainer) {}

	private get container(): StackContainer {
		return this.findMain();
	}

	/**
	 * The folder n8n treats as the user's home, resolved the way n8n does
	 * (`N8N_USER_FOLDER`, else `HOME`), so this matches where the fixture
	 * nodes write their import markers.
	 */
	private async getUserFolder(): Promise<string> {
		this.userFolder ??= this.container
			.exec([
				'sh',
				'-c',
				'if [ -n "$N8N_USER_FOLDER" ]; then printf %s "$N8N_USER_FOLDER"; else printf %s "$HOME"; fi',
			])
			.then(({ output, exitCode }) => {
				if (exitCode !== 0 || !output)
					throw new Error(`resolving the n8n user folder failed: ${output}`);
				return output;
			});
		return await this.userFolder;
	}

	async stateOf(packageName: string): Promise<PackageDiskState> {
		const userFolder = await this.getUserFolder();
		const nodesDir = `${userFolder}/.n8n/nodes`;
		const packageDir = `${nodesDir}/node_modules/${packageName}`;
		const markerDir = `${userFolder}/${IMPORT_MARKER_DIR}`;
		const script = [
			`if [ -d "${packageDir}" ]; then echo DIR=1; else echo DIR=0; fi`,
			`if [ -f "${packageDir}/package.json" ]; then echo "INSTALLED=$(node -p 'require("${packageDir}/package.json").version')"; fi`,
			`if [ -f "${nodesDir}/package.json" ]; then echo "LEDGER=$(node -p 'require("${nodesDir}/package.json").dependencies[${JSON.stringify(packageName)}] ?? ""')"; fi`,
			`if [ -d "${markerDir}" ]; then ls -1 "${markerDir}" | sed 's/^/MARKER=/'; fi`,
		].join('; ');
		const { output, exitCode } = await this.container.exec(['sh', '-c', script]);
		if (exitCode !== 0) throw new Error(`inspecting ${packageName} on disk failed: ${output}`);

		const lines = output.split('\n').map((line) => line.trim());
		const value = (key: string) =>
			lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) || undefined;

		return {
			directoryExists: value('DIR') === '1',
			installedVersion: value('INSTALLED'),
			ledgerVersion: value('LEDGER'),
			importMarkers: lines
				.filter((line) => line.startsWith('MARKER='))
				.map((line) => line.slice('MARKER='.length))
				.filter((marker) => marker.startsWith(`${packageName}@`)),
		};
	}
}

type CommunityPackageWorkerFixtures = {
	/** Publishes every fixture package into the stack's registry, once per worker. */
	publishedPackages: readonly FixturePackage[];
};

type CommunityPackageTestFixtures = {
	/**
	 * Node API level the instance under test supports, from its n8n major:
	 * 2.x runs level 1, 3.x runs level 3. `N8N_TEST_NODES_API_VERSION`
	 * overrides it for images where the mapping does not hold.
	 */
	supportedNodesApiVersion: number;
	/** Disk inspection inside the n8n main container. */
	packageDisk: CommunityPackageDisk;
};

/**
 * `test` for specs that install real community packages. Requires
 * `test.use({ capability: 'community-packages' })`.
 */
export const test = base.extend<CommunityPackageTestFixtures, CommunityPackageWorkerFixtures>({
	publishedPackages: [
		async ({ n8nContainer }, use) => {
			// Local mode has no stack; the containerRequirement fixture skips the tests.
			if (!n8nContainer) {
				await use([]);
				return;
			}
			const registry = n8nContainer.services.npmRegistry;
			const root = await mkdtemp(join(tmpdir(), 'community-package-fixtures-'));
			try {
				for (const pkg of PUBLISHED_PACKAGES) {
					await registry.publishDirectory(await writeFixturePackage(root, pkg));
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
			await use(PUBLISHED_PACKAGES);
		},
		{ scope: 'worker' },
	],

	supportedNodesApiVersion: async ({ api }, use) => {
		const override = process.env.N8N_TEST_NODES_API_VERSION;
		if (override) {
			await use(Number(override));
			return;
		}
		const response = await api.request.get('/rest/settings');
		const { data } = (await response.json()) as { data: { versionCli: string } };
		const major = Number(data.versionCli.split('.')[0]);
		await use(major >= 3 ? 3 : 1);
	},

	packageDisk: async ({ n8nContainer }, use, testInfo) => {
		testInfo.skip(!n8nContainer, 'Reading the n8n user folder needs container mode');
		const findMain = () => {
			const [main] = n8nContainer.findContainers(/-n8n(-main-1)?$/);
			if (!main) throw new Error('no n8n main container in this stack');
			return main;
		};
		findMain();
		await use(new CommunityPackageDisk(findMain));
	},
});

export { expect } from '../base';
