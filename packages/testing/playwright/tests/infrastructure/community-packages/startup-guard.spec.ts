import { TEST_CONTAINER_IMAGES } from 'n8n-containers/test-containers';
import type { N8NStack } from 'n8n-containers/stack';
import { mkdtempSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	expect,
	expectedOutcome,
	importMarkerName,
	INSTALLABLE_PACKAGES,
	LEGACY_PACKAGE_V3_UPDATE,
	nodeType,
	test,
	writeFixturePackage,
	type InstallOutcome,
} from '../../../fixtures/community-packages';

/**
 * The startup guard: a package on disk that requires a newer node API than the
 * instance supports must not be imported, must not take the instance down, and
 * must show up as failed to load in Settings > Community nodes.
 *
 * The state is produced the way it happens in the wild. A compatible release is
 * installed, so the package has a database row, then the folder on disk is
 * swapped for a release declaring a higher level, and n8n restarts on the
 * same user folder. The user folder is a bind mount, so the swap is a plain
 * file operation on the host.
 */

/** Host directory mounted as the container's home, so it outlives the restart. */
const HOME_DIR = mkdtempSync(join(tmpdir(), 'community-packages-startup-'));

const hostUser = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

test.use({
	capability: {
		services: ['npmRegistry'],
		env: {
			N8N_UNVERIFIED_PACKAGES_ENABLED: 'true',
			// A package the loader skipped must not be treated as missing and re-fetched.
			N8N_REINSTALL_MISSING_PACKAGES: 'true',
			// The container runs as the host user so the mounted files stay host-owned.
			HOME: '/home/node',
			N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
		},
		userHomeHostDir: HOME_DIR,
		user: hostUser(),
	},
});

/** Everything the main container logged since it started. */
async function readMainLogs(stack: N8NStack): Promise<string> {
	const [container] = stack.findContainers(/-n8n$/);
	if (!container) throw new Error('no n8n main container in this stack');
	const stream = await container.logs();
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve) => {
		stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		stream.on('end', resolve);
		stream.on('error', () => resolve());
		// docker follows the stream; the history arrives well within this window.
		setTimeout(resolve, 2000);
	});
	return Buffer.concat(chunks).toString('utf8');
}

test.describe('Community node API version guard at startup @mode:sqlite', () => {
	test.afterAll(async () => {
		await rm(HOME_DIR, { recursive: true, force: true });
	});

	test(
		'an installed package whose on-disk release requires a newer node API is skipped at boot',
		{ annotation: [{ type: 'owner', description: 'NODES' }] },
		async ({
			api,
			n8n,
			n8nContainer,
			packageDisk,
			publishedPackages,
			supportedNodesApiVersion,
		}) => {
			expect(publishedPackages.length).toBeGreaterThan(0);
			const installed = INSTALLABLE_PACKAGES.legacy;
			const onDisk = LEGACY_PACKAGE_V3_UPDATE;
			const outcome = expectedOutcome(onDisk, supportedNodesApiVersion);

			await api.enableFeature('communityNodes:customRegistry');
			const install = await api.communityPackages.install(`${installed.name}@${installed.version}`);
			expect(install.status()).toBe(200);
			await expect(api.communityPackages.nodeTypeNames()).resolves.toContain(nodeType(installed));

			// Swap the folder on disk for the release the guard has to judge.
			const packageDir = join(HOME_DIR, '.n8n', 'nodes', 'node_modules', onDisk.name);
			const scratch = await mkdtemp(join(tmpdir(), 'community-packages-on-disk-'));
			try {
				const source = await writeFixturePackage(scratch, onDisk);
				await rm(packageDir, { recursive: true, force: true });
				await cp(source, packageDir, { recursive: true });
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
			await expect(packageDisk.stateOf(onDisk.name)).resolves.toMatchObject({
				installedVersion: onDisk.version,
			});

			await n8nContainer.replaceN8N({ image: TEST_CONTAINER_IMAGES.n8n });

			// The instance is up: readiness passed inside replaceN8N, and the API answers.
			const listed = await api.communityPackages.find(onDisk.name);
			expect(listed).toBeDefined();

			const logs = await readMainLogs(n8nContainer);
			const disk = await packageDisk.stateOf(onDisk.name);
			await n8n.navigate.toCommunityNodes();
			const card = n8n.communityNodes.getCommunityCard(onDisk.name);
			await expect(card).toBeVisible();

			const assertions: Record<InstallOutcome, () => Promise<void>> = {
				rejectedUnsupported: async () => {
					expect(logs).toContain(`Skipping package "${onDisk.name}"`);
					expect(logs).toContain(`Not reinstalling package "${onDisk.name}"`);
					expect(listed).toMatchObject({ failedLoading: true });
					await expect(api.communityPackages.nodeTypeNames()).resolves.not.toContain(
						nodeType(onDisk),
					);
					// Skipped means never imported: the marker the module would write is absent.
					expect(disk.importMarkers).not.toContain(importMarkerName(onDisk));
					await expect(card.locator('[data-icon="triangle-alert"]')).toBeVisible();
				},
				accepted: async () => {
					expect(logs).not.toContain(`Skipping package "${onDisk.name}"`);
					expect(listed).toMatchObject({ failedLoading: false });
					await expect(api.communityPackages.nodeTypeNames()).resolves.toContain(nodeType(onDisk));
					expect(disk.importMarkers).toContain(importMarkerName(onDisk));
					await expect(card.locator('[data-icon="triangle-alert"]')).toBeHidden();
				},
				rejectedMalformed: async () => {
					throw new Error(`${onDisk.name} declares a valid level and cannot be malformed`);
				},
			};
			await assertions[outcome]();
		},
	);
});
