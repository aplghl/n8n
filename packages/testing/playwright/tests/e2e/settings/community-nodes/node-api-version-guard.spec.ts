import type { APIResponse } from '@playwright/test';

import {
	expect,
	expectedOutcome,
	importMarkerName,
	INSTALLABLE_PACKAGES,
	LEGACY_PACKAGE_V3_UPDATE,
	nodeType,
	test,
	type CommunityPackageDisk,
	type FixturePackage,
	type InstallOutcome,
} from '../../../../fixtures/community-packages';
import type { ApiHelpers } from '../../../../services/api-helper';

/**
 * The node API compatibility guard, end to end: a real n8n installs real
 * packages from a registry the suite seeds, and only the ones whose
 * `n8n.n8nNodesApiVersion` the instance supports make it onto disk.
 *
 * The expectations follow the instance under test: a 2.x image supports
 * level 1 and rejects the level-3 packages, a 3.x image accepts them. A
 * malformed declaration is rejected everywhere.
 */
test.use({ capability: 'community-packages' });

const INCOMPATIBLE_INSTALL_TOAST = 'Package not compatible with this n8n version';
const INCOMPATIBLE_UPDATE_TOAST = 'Update not compatible with this n8n version';

const describeRequirement = (pkg: FixturePackage): string =>
	pkg.requirement.kind === 'malformed'
		? `n8nNodesApiVersion ${JSON.stringify(pkg.nodesApiVersion)}`
		: pkg.nodesApiVersion === undefined
			? 'no n8nNodesApiVersion'
			: `n8nNodesApiVersion ${pkg.nodesApiVersion}`;

interface InstallContext {
	api: ApiHelpers;
	packageDisk: CommunityPackageDisk;
	pkg: FixturePackage;
	response: APIResponse;
	supportedNodesApiVersion: number;
}

async function expectInstalled({ api, packageDisk, pkg }: InstallContext): Promise<void> {
	await expect(api.communityPackages.find(pkg.name)).resolves.toMatchObject({
		installedVersion: pkg.version,
	});
	await expect(api.communityPackages.nodeTypeNames()).resolves.toContain(nodeType(pkg));

	const disk = await packageDisk.stateOf(pkg.name);
	expect(disk).toMatchObject({
		directoryExists: true,
		installedVersion: pkg.version,
		ledgerVersion: pkg.version,
	});
	expect(disk.importMarkers).toContain(importMarkerName(pkg));
}

/** Nothing of the package may remain: no DB row, no node type, no files, and its code never ran. */
async function expectAbsent({
	api,
	packageDisk,
	pkg,
}: Pick<InstallContext, 'api' | 'packageDisk' | 'pkg'>): Promise<void> {
	await expect(api.communityPackages.find(pkg.name)).resolves.toBeUndefined();
	await expect(api.communityPackages.nodeTypeNames()).resolves.not.toContain(nodeType(pkg));
	await expect(packageDisk.stateOf(pkg.name)).resolves.toEqual({
		directoryExists: false,
		installedVersion: undefined,
		ledgerVersion: undefined,
		importMarkers: [],
	});
}

const installAssertions: Record<InstallOutcome, (ctx: InstallContext) => Promise<void>> = {
	accepted: async (ctx) => {
		expect(ctx.response.status()).toBe(200);
		await expectInstalled(ctx);
	},
	rejectedUnsupported: async (ctx) => {
		const { pkg, supportedNodesApiVersion } = ctx;
		expect(ctx.response.status()).toBe(400);
		const rejection = await ctx.api.communityPackages.readRejection(ctx.response);
		expect(rejection.message).toContain("isn't compatible with your version of n8n");
		// Levels are numbers today and may become `major.minor` strings later.
		expect(String(rejection.meta.requiredNodesApiVersion)).toBe(String(pkg.nodesApiVersion));
		expect(String(rejection.meta.supportedNodesApiVersion)).toBe(String(supportedNodesApiVersion));
		await expectAbsent(ctx);
	},
	rejectedMalformed: async (ctx) => {
		expect(ctx.response.status()).toBe(400);
		const rejection = await ctx.api.communityPackages.readRejection(ctx.response);
		expect(rejection.message).toContain('declares an invalid n8n node API version');
		expect(rejection.meta.requiredNodesApiVersion).toBeNull();
		await expectAbsent(ctx);
	},
};

test.describe(
	'Community node API version guard',
	{
		annotation: [{ type: 'owner', description: 'NODES' }],
	},
	() => {
		test.beforeEach(async ({ api, publishedPackages }) => {
			expect(publishedPackages.length).toBeGreaterThan(0);
			// A non-default registry is a licensed feature; the seeded registry is one.
			await api.enableFeature('communityNodes:customRegistry');
		});

		test.afterEach(async ({ api }) => {
			await api.communityPackages.uninstallAll();
		});

		for (const pkg of Object.values(INSTALLABLE_PACKAGES)) {
			// eslint-disable-next-line playwright/expect-expect -- assertions live in installAssertions
			test(`install of a package with ${describeRequirement(pkg)} is decided by the guard`, async ({
				api,
				packageDisk,
				supportedNodesApiVersion,
			}) => {
				const outcome = expectedOutcome(pkg, supportedNodesApiVersion);
				const response = await api.communityPackages.install(`${pkg.name}@${pkg.version}`);
				await installAssertions[outcome]({
					api,
					packageDisk,
					pkg,
					response,
					supportedNodesApiVersion,
				});
			});
		}

		test('settings page explains a rejected install instead of installing the package', async ({
			n8n,
			api,
			packageDisk,
			supportedNodesApiVersion,
		}) => {
			const pkg = INSTALLABLE_PACKAGES.v3;
			const outcome = expectedOutcome(pkg, supportedNodesApiVersion);
			await n8n.navigate.toCommunityNodes();

			await n8n.communityNodes.clickInstallButton();
			await n8n.communityNodes.fillPackageName(`${pkg.name}@${pkg.version}`);
			await n8n.communityNodes.clickUserAgreementCheckbox();
			await n8n.communityNodes.clickInstallPackageButton();

			const uiAssertions: Record<InstallOutcome, () => Promise<void>> = {
				accepted: async () => {
					await expect(n8n.notifications.getNotificationByTitle('Package installed')).toBeVisible();
					await expect(n8n.communityNodes.getCommunityCard(pkg.name)).toContainText(
						`v${pkg.version}`,
					);
				},
				rejectedUnsupported: async () => {
					await expect(
						n8n.notifications.getNotificationByTitle(INCOMPATIBLE_INSTALL_TOAST),
					).toBeVisible();
					await expect(
						n8n.communityNodes.getInstallModalError(/isn't compatible with your version of n8n/),
					).toBeVisible();
					await expect(api.communityPackages.find(pkg.name)).resolves.toBeUndefined();
					await expect(packageDisk.stateOf(pkg.name)).resolves.toMatchObject({
						directoryExists: false,
						importMarkers: [],
					});
				},
				rejectedMalformed: async () => {
					throw new Error(`${pkg.name} declares a valid level and cannot be malformed`);
				},
			};
			await uiAssertions[outcome]();
		});

		test('malformed n8nNodesApiVersion is reported as incompatible on the settings page', async ({
			n8n,
			api,
			packageDisk,
		}) => {
			const pkg = INSTALLABLE_PACKAGES.malformed;
			await n8n.navigate.toCommunityNodes();

			await n8n.communityNodes.clickInstallButton();
			await n8n.communityNodes.fillPackageName(`${pkg.name}@${pkg.version}`);
			await n8n.communityNodes.clickUserAgreementCheckbox();
			await n8n.communityNodes.clickInstallPackageButton();

			await expect(
				n8n.notifications.getNotificationByTitle(INCOMPATIBLE_INSTALL_TOAST),
			).toBeVisible();
			await expect(
				n8n.communityNodes.getInstallModalError(/declares an invalid n8n node API version/),
			).toBeVisible();
			await expectAbsent({ api, packageDisk, pkg });
		});

		test('update to a release declaring a newer node API version is decided by the guard (API)', async ({
			api,
			packageDisk,
			supportedNodesApiVersion,
		}) => {
			const installed = INSTALLABLE_PACKAGES.legacy;
			const update = LEGACY_PACKAGE_V3_UPDATE;
			const outcome = expectedOutcome(update, supportedNodesApiVersion);

			const install = await api.communityPackages.install(`${installed.name}@${installed.version}`);
			expect(install.status()).toBe(200);

			const response = await api.communityPackages.update(update.name, update.version);

			const updateAssertions: Record<InstallOutcome, () => Promise<void>> = {
				accepted: async () => {
					expect(response.status()).toBe(200);
					await expectInstalled({
						api,
						packageDisk,
						pkg: update,
						response,
						supportedNodesApiVersion,
					});
				},
				rejectedUnsupported: async () => {
					expect(response.status()).toBe(400);
					const rejection = await api.communityPackages.readRejection(response);
					expect(String(rejection.meta.requiredNodesApiVersion)).toBe(
						String(update.nodesApiVersion),
					);
					// The previous release stays installed, loaded, and untouched on disk.
					await expectInstalled({
						api,
						packageDisk,
						pkg: installed,
						response,
						supportedNodesApiVersion,
					});
					const disk = await packageDisk.stateOf(update.name);
					expect(disk.importMarkers).not.toContain(importMarkerName(update));
				},
				rejectedMalformed: async () => {
					throw new Error(`${update.name} declares a valid level and cannot be malformed`);
				},
			};
			await updateAssertions[outcome]();
		});

		test('update to a release declaring a newer node API version is decided by the guard (settings page)', async ({
			n8n,
			api,
			packageDisk,
			supportedNodesApiVersion,
		}) => {
			const installed = INSTALLABLE_PACKAGES.legacy;
			const update = LEGACY_PACKAGE_V3_UPDATE;
			const outcome = expectedOutcome(update, supportedNodesApiVersion);

			const install = await api.communityPackages.install(`${installed.name}@${installed.version}`);
			expect(install.status()).toBe(200);

			await n8n.navigate.toCommunityNodes();
			await expect(n8n.communityNodes.getCommunityCard(installed.name)).toContainText(
				`v${installed.version}`,
			);
			await n8n.communityNodes.updatePackage(installed.name);

			const updateAssertions: Record<InstallOutcome, () => Promise<void>> = {
				accepted: async () => {
					await expect(n8n.notifications.getNotificationByTitle('Package updated')).toBeVisible();
					await expect(n8n.communityNodes.getCommunityCard(update.name)).toContainText(
						`v${update.version}`,
					);
				},
				rejectedUnsupported: async () => {
					await expect(
						n8n.notifications.getNotificationByTitle(INCOMPATIBLE_UPDATE_TOAST),
					).toBeVisible();
					await expect(n8n.communityNodes.getCommunityCard(installed.name)).toContainText(
						`v${installed.version}`,
					);
					await expect(packageDisk.stateOf(installed.name)).resolves.toMatchObject({
						installedVersion: installed.version,
						ledgerVersion: installed.version,
					});
					const disk = await packageDisk.stateOf(update.name);
					expect(disk.importMarkers).not.toContain(importMarkerName(update));
				},
				rejectedMalformed: async () => {
					throw new Error(`${update.name} declares a valid level and cannot be malformed`);
				},
			};
			await updateAssertions[outcome]();
		});
	},
);
