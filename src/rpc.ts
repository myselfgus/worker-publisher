import { WorkerEntrypoint } from 'cloudflare:workers';
import Cloudflare from 'cloudflare';
import { nanoid } from 'nanoid';

export class WorkerPublisherRPC extends WorkerEntrypoint<Env> {
	/**
	 * Deploy worker from meta-mcp to dispatch namespace
	 * @param serverId MCP server ID
	 * @param workerName Name for the deployed worker
	 * @param scriptContent Built worker script content
	 * @param bindings Optional Cloudflare bindings (KV, R2, D1, etc.)
	 */
	async deployFromMetaMCP(
		serverId: string,
		workerName: string,
		scriptContent: string,
		bindings: Array<
			| { type: "plain_text"; name: string; text: string }
			| { type: "kv_namespace"; name: string; namespace_id: string }
			| { type: "r2_bucket"; name: string; bucket_name: string }
			| { type: "d1"; name: string; id: string }
		> = []
	) {
		try {
			const deploymentId = nanoid();
			const namespace = 'meta-mcp';

			// Record deployment start
			await this.env.DB.prepare(`
				INSERT INTO worker_deployments (id, worker_name, server_id, namespace, script_content, status)
				VALUES (?, ?, ?, ?, ?, ?)
			`).bind(
				deploymentId,
				workerName,
				serverId,
				namespace,
				scriptContent,
				'deploying'
			).run();

			// Deploy using Cloudflare API
			const cf = new Cloudflare({
				apiToken: this.env.CLOUDFLARE_API_TOKEN,
			});

			// Ensure namespace exists
			try {
				await cf.workersForPlatforms.dispatch.namespaces.get(namespace, {
					account_id: this.env.CLOUDFLARE_ACCOUNT_ID,
				});
			} catch {
				await cf.workersForPlatforms.dispatch.namespaces.create({
					account_id: this.env.CLOUDFLARE_ACCOUNT_ID,
					name: namespace,
				});
			}

			const moduleFileName = `${workerName}.mjs`;

			// Upload worker to namespace
			await cf.workersForPlatforms.dispatch.namespaces.scripts.update(
				namespace,
				workerName,
				{
					account_id: this.env.CLOUDFLARE_ACCOUNT_ID,
					metadata: {
						main_module: moduleFileName,
						bindings,
					},
					files: {
						[moduleFileName]: new File([scriptContent], moduleFileName, {
							type: "application/javascript+module",
						}),
					},
				},
			);

			const deploymentUrl = `https://${workerName}.meta-mcp.workers.dev`;

			// Update deployment record
			await this.env.DB.prepare(`
				UPDATE worker_deployments
				SET status = ?, deployed_at = ?, deployment_url = ?
				WHERE id = ?
			`).bind('active', Date.now(), deploymentUrl, deploymentId).run();

			// Update mcp_servers table
			await this.env.DB.prepare(`
				UPDATE mcp_servers
				SET worker_name = ?, status = 'active', updated_at = ?
				WHERE id = ?
			`).bind(workerName, Date.now(), serverId).run();

			return {
				success: true,
				deploymentId,
				workerName,
				namespace,
				deploymentUrl
			};
		} catch (error) {
			console.error('Failed to deploy worker:', error);

			// Update deployment status to failed
			await this.env.DB.prepare(`
				UPDATE worker_deployments
				SET status = 'failed', metadata = ?
				WHERE worker_name = ?
			`).bind(
				JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
				workerName
			).run();

			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * List all deployments
	 */
	async listDeployments(limit: number = 100, offset: number = 0) {
		try {
			const result = await this.env.DB.prepare(`
				SELECT * FROM worker_deployments
				ORDER BY deployed_at DESC
				LIMIT ? OFFSET ?
			`).bind(limit, offset).all();

			return {
				success: true,
				deployments: result.results || [],
				count: result.results?.length || 0
			};
		} catch (error) {
			console.error('Failed to list deployments:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Get deployment status
	 */
	async getDeploymentStatus(deploymentId: string) {
		try {
			const result = await this.env.DB.prepare(`
				SELECT * FROM worker_deployments WHERE id = ?
			`).bind(deploymentId).first();

			if (!result) {
				return {
					success: false,
					error: 'Deployment not found'
				};
			}

			return {
				success: true,
				deployment: result
			};
		} catch (error) {
			console.error('Failed to get deployment status:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Update existing deployment with new script
	 */
	async updateDeployment(deploymentId: string, scriptContent: string) {
		try {
			// Get deployment info
			const deployment = await this.env.DB.prepare(`
				SELECT * FROM worker_deployments WHERE id = ?
			`).bind(deploymentId).first() as any;

			if (!deployment) {
				return {
					success: false,
					error: 'Deployment not found'
				};
			}

			// Deploy using Cloudflare API
			const cf = new Cloudflare({
				apiToken: this.env.CLOUDFLARE_API_TOKEN,
			});

			const moduleFileName = `${deployment.worker_name}.mjs`;

			await cf.workersForPlatforms.dispatch.namespaces.scripts.update(
				deployment.namespace,
				deployment.worker_name,
				{
					account_id: this.env.CLOUDFLARE_ACCOUNT_ID,
					metadata: {
						main_module: moduleFileName,
					},
					files: {
						[moduleFileName]: new File([scriptContent], moduleFileName, {
							type: "application/javascript+module",
						}),
					},
				},
			);

			// Update record
			await this.env.DB.prepare(`
				UPDATE worker_deployments
				SET script_content = ?, deployed_at = ?
				WHERE id = ?
			`).bind(scriptContent, Date.now(), deploymentId).run();

			return {
				success: true,
				deploymentId,
				workerName: deployment.worker_name
			};
		} catch (error) {
			console.error('Failed to update deployment:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Delete deployment from namespace
	 */
	async deleteDeployment(deploymentId: string) {
		try {
			// Get deployment info
			const deployment = await this.env.DB.prepare(`
				SELECT * FROM worker_deployments WHERE id = ?
			`).bind(deploymentId).first() as any;

			if (!deployment) {
				return {
					success: false,
					error: 'Deployment not found'
				};
			}

			// Delete from Cloudflare
			const cf = new Cloudflare({
				apiToken: this.env.CLOUDFLARE_API_TOKEN,
			});

			await cf.workersForPlatforms.dispatch.namespaces.scripts.delete(
				deployment.namespace,
				deployment.worker_name,
				{
					account_id: this.env.CLOUDFLARE_ACCOUNT_ID,
				}
			);

			// Delete from database
			await this.env.DB.prepare(`
				DELETE FROM worker_deployments WHERE id = ?
			`).bind(deploymentId).run();

			return {
				success: true,
				deploymentId
			};
		} catch (error) {
			console.error('Failed to delete deployment:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}
}
