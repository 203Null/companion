/*
 * This file is part of the Companion project
 * Copyright (c) 2018 Bitfocus AS
 * Authors: William Viker <william@bitfocus.io>, Håkon Nessjøen <haakon@bitfocus.io>
 *
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 *
 */

const fs = require('fs-extra')
const shortid = require('shortid')
const { from15to32, rgb, rgbRev, sendResult } = require('../Resources/Util')
const CoreBase = require('../Core/Base')
const InstancePreset = require('./Preset')
const InstanceVariable = require('./Variable')
const path = require('path')
const ModuleHost = require('./Host')
const InstanceStatus = require('./Status')
// const { validateManifest } = require('../../module-base/dist/manifest')

class Instance extends CoreBase {
	constructor(registry) {
		super(registry, 'instance', 'lib/Instance/Controller')

		this.variable = new InstanceVariable(registry)
		this.preset = new InstancePreset(registry)
		this.status = new InstanceStatus(registry)
		this.moduleHost = new ModuleHost(registry, this.status)

		this.modules = {}
		this.modules_main = {}

		/** Object of the known modules that can be loaded */
		this.known_modules = {}
		/** Sometimes modules get renamed/merged. This lets that happen */
		this.module_renames = {}

		this.store = {
			db: {},
		}

		this.store.db = this.db.getKey('instance', {})

		// Ensure there is the internal module defined
		if (this.store.db['bitfocus-companion'] === undefined) {
			this.store.db['bitfocus-companion'] = {
				instance_type: 'bitfocus-companion',
				label: 'internal',
				id: 'bitfocus-companion',
			}
		}

		this.system.on('instance_config_get', (id, cb) => {
			cb(this.getInstanceConfig(id))
		})

		this.system.on('instance_get_label', (id, cb) => {
			cb(this.store.db[id]?.label)
		})

		this.system.on('instance_delete', (id) => {
			this.system.emit('log', 'instance(' + id + ')', 'info', 'instance deleted')

			this.moduleHost
				.queueStopConnection(id)
				.catch((e) => {
					this.system.emit('log', 'instance(' + id + ')', 'debug', 'Error while deleting instance: ' + e.message)
				})
				.then(() => {
					this.status.forgetInstanceStatus(id)
					delete this.store.db[id]

					this.io.emit('instances_get:result', this.store.db)
					this.doSave()
				})
		})

		// TODO
		// this.system.on('launcher-power-status', (event) => {
		// 	if (event == 'resume') {
		// 		this.system.emit('log', 'system(power)', 'info', 'Resuming')

		// 		for (const id in this.active) {
		// 			this.system.emit(
		// 				'log',
		// 				'instance(' + this.active[id].label + ')',
		// 				'debug',
		// 				'Bringing back instance from sleep'
		// 			)
		// 			this.activate_module(id)
		// 		}
		// 	} else if (event == 'suspend') {
		// 		this.system.emit('log', 'system(power)', 'info', 'Suspending')

		// 		for (const id in this.active) {
		// 			if (
		// 				this.active[id] !== undefined &&
		// 				this.active[id].destroy !== undefined &&
		// 				typeof this.active[id].destroy == 'function'
		// 			) {
		// 				try {
		// 					this.active[id].destroy()
		// 				} catch (e) {
		// 					this.system.emit(
		// 						'log',
		// 						'instance(' + this.active[id].label + ')',
		// 						'debug',
		// 						'Error suspending instance: ' + e.message
		// 					)
		// 				}
		// 			}
		// 		}
		// 	}
		// })

		this.system.on('http_req', (req, res, done) => {
			let match

			if ((match = req.url.match(/^\/help\/module\/([^/]+)\/(.+?)(\?.+)?$/))) {
				const module_id = match[1].replace(/\.\.+/g, '')
				const file = match[2].replace(/\.\.+/g, '')

				console.log(module_id, file)

				const moduleInfo = this.known_modules[module_id]
				if (moduleInfo && moduleInfo.helpPath && moduleInfo.basePath) {
					const fullpath = path.join(moduleInfo.basePath, 'companion', file)
					if (file.match(/\.(jpe?g|gif|png|pdf)$/) && fs.existsSync(fullpath)) {
						done()
						res.sendFile(fullpath)
					}
				}
			}
		})

		// TODO: Implement dependency system
		setTimeout(async () => {
			this.debug('instance_init', this.store.db)

			const rootPath = require('app-root-path').toString()
			const searchDirs = [
				// Paths to look for modules, in order of priority
				path.join(rootPath, '/module-legacy/manifests'),
				path.join(rootPath, '/module-local-dev'),
			]

			// TODO - this would be good to be async so it can be done more in parallel
			// But make sure to keep it deterministic

			for (const searchDir of searchDirs) {
				if (fs.existsSync(searchDir)) {
					const candidates = fs.readdirSync(searchDir)
					for (const candidate of candidates) {
						const candidatePath = path.join(searchDir, candidate)
						this.loadInfoForModule(candidatePath)
					}
				}
			}

			await this.moduleHost.start()

			for (const id in this.store.db) {
				this.activate_module(id, false)
			}

			this.system.emit('instances_loaded')
		}, 2000)

		this.system.on(
			'instance_upgrade_imported',
			(instance_id, instance_created, instance_type, imported_config, actions, feedbacks) => {
				if (this.checkModuleLoaded(instance_type)) {
					this.upgrade_instance_config_partial(
						instance_id,
						instance_type,
						imported_config._configIdx,
						imported_config, // upgrade the config, even though we won't save the result anywhere
						actions,
						feedbacks
					)
				}
			}
		)

		this.system.emit('instance', this)

		this.system.on('io_connect', this.clientConnect.bind(this))

		this.system.on('instance_add', (data, cb, disabled) => {
			let module = data.type
			let product = data.product

			const moduleInfo = this.known_modules[module]
			if (moduleInfo) {
				let id = shortid.generate()

				this.store.db[id] = {}

				this.system.emit('log', 'instance(' + id + ')', 'info', 'instance add ' + module + ' ' + product)

				this.store.db[id].instance_type = module
				this.store.db[id].product = product

				let label = moduleInfo.display.shortname
				let i = 1
				let freename = false

				while (!freename) {
					freename = true
					for (const key in this.store.db) {
						if (this.store.db[key].label == label) {
							i++
							label = moduleInfo.display.shortname + i
							freename = false
							break
						}
					}
				}

				this.store.db[id].label = label

				if (disabled) {
					this.store.db[id].enabled = false
				}

				this.activate_module(id, true)

				this.io.emit('instances_get:result', this.store.db)
				this.debug('instance_add', id)
				this.doSave()

				if (typeof cb == 'function') {
					cb(id, this.store.db[id])
				}
			}
		})

		this.system.on('instance_activate', (id) => {
			this.activate_module(id)
		})

		this.system.on('instance_config_put', (id, config, skip_notify_instance) => {
			const oldLabel = this.store.db[id]?.label

			for (const key in config) {
				this.store.db[id][key] = config[key]
			}

			// Rename variables
			if (oldLabel != this.store.db[id].label) {
				this.system.emit('variable_instance_label_rename', oldLabel, this.store.db[id].label, id)
			}

			this.doSave()
			this.io.emit('instances_get:result', this.store.db)

			if (!skip_notify_instance) {
				const instance = this.instance.moduleHost.getChild(id)
				if (instance) {
					instance.updateConfig(config).catch((e) => {
						this.system.emit(
							'log',
							'instance(' + config.label + ')',
							'warn',
							'Error updating instance configuration: ' + e.message
						)
					})
				}
			}

			this.system.emit('log', 'instance(' + id + ')', 'debug', 'instance configuration updated')
		})

		this.system.on('instance_enable', (id, state) => {
			if (this.store.db[id].enabled !== state) {
				this.system.emit(
					'log',
					'instance(' + id + ')',
					'info',
					(state ? 'Enable' : 'Disable') + ' instance ' + this.store.db[id].label
				)
				this.store.db[id].enabled = state

				if (state === true) {
					this.status.updateInstanceStatus(id, null, 'Enabling')
				} else {
					this.status.updateInstanceStatus(id, -1, 'Disabled')
				}

				if (state === false) {
					this.moduleHost.queueStopConnection(id).catch((e) => {
						this.system.emit('log', 'instance(' + id + ')', 'warn', 'Error disabling instance: ' + e.message)
					})
				} else {
					this.activate_module(id)
				}

				this.doSave()
			} else {
				if (state === true) {
					this.system.emit('log', 'instance(' + id + ')', 'warn', 'Attempting to enable module that is alredy enabled')
				} else {
					this.system.emit(
						'log',
						'instance(' + id + ')',
						'warn',
						'Attempting to disable module that is alredy disabled'
					)
				}
			}
		})
	}

	/**
	 * Checks whether an instance_type has been renamed
	 * @param {string} instance_type
	 * @returns {string} the instance_type that should be used (often the provided parameter)
	 */
	verifyInstanceTypeIsCurrent(instance_type) {
		return this.module_renames[instance_type] || instance_type
	}

	/**
	 * Get information for the metrics system about the current instances
	 */
	getInstancesMetrics() {
		const instancesCounts = {}

		for (const instance_config of Object.values(this.store.db)) {
			if (instance_config.instance_type !== 'bitfocus-companion' && instance_config.enabled !== false) {
				if (instancesCounts[instance_config.instance_type]) {
					instancesCounts[instance_config.instance_type]++
				} else {
					instancesCounts[instance_config.instance_type] = 1
				}
			}
		}

		return instancesCounts
	}

	/**
	 * Stop/destroy all running instances
	 */
	async destroyAllInstances() {
		return this.moduleHost.queueStopAll()
	}

	/**
	 * Save the instances config to the db
	 * @access protected
	 */
	doSave() {
		this.db.setKey('instance', this.store.db)
	}

	/**
	 * Get the status of an instance
	 * @param {String} instance_id
	 * @returns {number} ??
	 */
	getInstanceStatus(instance_id) {
		return this.status.getInstanceStatus(instance_id)
	}

	/**
	 * Get the config object of an instance
	 * @param {String} instance_id
	 * @returns {Object}
	 */
	getInstanceConfig(instance_id) {
		return this.store.db[instance_id]
	}

	upgrade_instance_config(id, instance_type) {
		const mod = this.modules[instance_type]
		if (!mod || mod.GetUpgradeScripts === undefined) {
			return
		}

		// Fetch instance actions
		let actions = []
		this.system.emit('actions_for_instance', id, (_actions) => {
			actions = _actions
		})
		let feedbacks = []
		this.system.emit('feedbacks_for_instance', id, (_feedbacks) => {
			feedbacks = _feedbacks
		})

		const config = this.store.db[id]
		const changed = this.upgrade_instance_config_partial(
			id,
			instance_type,
			config._configIdx,
			config,
			actions,
			feedbacks
		)

		// If anything was changed, update system and db
		if (changed) {
			this.system.emit('action_save')
			this.system.emit('feedback_save')
		}
		this.debug('instance save')
		this.doSave()
	}

	upgrade_instance_config_partial(id, instance_type, from_idx, upgrade_config, actions, feedbacks) {
		const debug = require('debug')('instance/' + instance_type + '/' + id)

		debug(`upgrade_instance_config_partial(${instance_type}): starting`)

		const mod = this.modules[instance_type]
		if (!mod || mod.GetUpgradeScripts === undefined) {
			debug(`upgrade_instance_config_partial(${instance_type}): nothing to do`)
			return
		}

		let idx = from_idx
		if (idx === undefined) {
			idx = -1
		}

		// Allow forcing the scripts to run from an earlier point
		if (process.env.DEVELOPER && typeof mod.DEVELOPER_forceStartupUpgradeScript === 'number') {
			idx = mod.DEVELOPER_forceStartupUpgradeScript - 1
		}

		const upgrade_scripts = mod.GetUpgradeScripts() || []
		if (idx + 1 < upgrade_scripts.length) {
			debug(`upgrade_instance_config_partial(${instance_type}): ${idx + 1} to ${upgrade_scripts.length}`)

			const context = {
				convert15to32: from15to32,
				rgb: rgb,
				rgbRev: rgbRev,
			}

			let changed = false
			for (let i = idx + 1; i < upgrade_scripts.length; ++i) {
				debug(`upgrade_instance_config_partial: Upgrading to version ${i + 1}`)

				try {
					const result = upgrade_scripts[i](context, upgrade_config, actions, feedbacks)
					changed = changed || result
				} catch (e) {
					debug(`Upgradescript in ${instance_type} failed: ${e}`)
				}

				if (upgrade_config) {
					upgrade_config._configIdx = i
				}
			}

			// ensure the ids havent been accidentally mangled
			for (const action of actions) {
				action.instance = id
				action.label = `${id}:${action.action}`
			}
			for (const feedback of feedbacks) {
				feedback.instance_id = id
			}

			// If we have no upgrade_config, we can avoid saving the config as we know we only have a reference here and nothing worth announcing has been changed
			// Also doing the save would be bad as we would potentially wipe some other changes
			if (upgrade_config && idx + 1 < upgrade_scripts.length) {
				// Save config, but do not automatically call this module's updateConfig again
				this.system.emit('instance_config_put', id, upgrade_config, true)
			}

			return changed
		} else {
			return false
		}
	}

	activate_module(id, is_being_created) {
		const config = this.store.db[id]
		if (!config) throw new Error('Cannot activate unknown module')

		config.instance_type = this.verifyInstanceTypeIsCurrent(config.instance_type)

		if (config.enabled === false) {
			this.debug("Won't load disabled module " + id + ' (' + config.instance_type + ')')
			return
		}

		// TODO
		// 	if (is_being_created && this.store.db[id]._configIdx === undefined) {
		// 		// New instances do not need to be upgraded
		// 		if (mod.GetUpgradeScripts !== undefined) {
		// 			const scripts = mod.GetUpgradeScripts()
		// 			if (scripts !== undefined && scripts.length > 0) {
		// 				this.store.db[id]._configIdx = scripts.length - 1
		// 			}
		// 		}
		// 	}

		const moduleInfo = this.known_modules[config.instance_type]
		if (!moduleInfo) {
			this.debug('Configured instance ' + config.instance_type + ' could not be loaded, unknown module')
			this.system.emit(
				'log',
				'instance(' + config.instance_type + ')',
				'error',
				'Configured instance ' + config.instance_type + ' could not be loaded, unknown module'
			)
		} else {
			this.moduleHost.queueRestartConnection(id, config, moduleInfo).catch((e) => {
				this.debug('Configured instance ' + config.instance_type + ' failed to start: ' + e.message)
				this.system.emit(
					'log',
					'instance(' + config.instance_type + ')',
					'error',
					'Configured instance ' + config.instance_type + ' failed to start'
				)
			})
		}
	}

	checkModuleLoaded(instance_type) {
		let out = false

		if (this.modules[instance_type] === undefined && this.modules_main[instance_type] !== undefined) {
			try {
				let mod = require(this.modules_main[instance_type])
				this.modules[instance_type] = mod
				out = true
			} catch (e) {
				this.debug('Error loading module ' + instance_type, e)
				this.system.emit('log', 'module(' + instance_type + ')', 'error', 'Error loading module: ' + e)
			}
		} else if (this.modules[instance_type] !== undefined) {
			out = true
		}

		return out
	}

	clientConnect(client) {
		this.status.clientConnect(client)

		client.on('instances_get', () => {
			client.emit('instances_get:result', this.store.db)
		})

		client.on('modules_get', (answer) => {
			answer({
				modules: Object.values(this.known_modules).map((mod) => mod.display),
			})
		})

		client.on('instance_edit', (id, answer) => {
			const instance = this.instance.moduleHost.getChild(id)
			if (instance) {
				instance
					.requestConfigFields()
					.then((fields) => {
						const configFields = [
							{
								type: 'textinput',
								id: 'label',
								label: 'Label',
								width: 12,
							},
							...fields,
						]

						sendResult(client, answer, 'instance_edit:result', id, configFields, this.store.db[id])
					})
					.catch((e) => {
						this.debug(`Failed to load instance config_fields: ${e.message}`)
						answer(null)
					})
			} else {
				// Unknown instance
				answer(null)
			}
		})

		client.on('instance_config_put', (id, config, answer) => {
			for (const inst in this.store.db) {
				if (inst != id && this.store.db[inst].label == config.label) {
					sendResult(client, answer, 'instance_config_put:result', 'duplicate label')
					return
				}
			}

			this.system.emit('instance_config_put', id, config)

			sendResult(client, answer, 'instance_config_put:result', null, 'ok')
		})

		client.on('instance_enable', (id, state) => {
			this.system.emit('instance_enable', id, state)

			client.emit('instances_get:result', this.store.db)
		})

		client.on('instance_delete', (id) => {
			this.system.emit('instance_delete', id, this.store.db[id] !== undefined ? this.store.db[id].label : undefined)
		})

		client.on('instance_add', (module, answer) => {
			this.system.emit('instance_add', module, (id) => {
				sendResult(client, answer, 'instance_add:result', id)
			})
		})

		client.on('instance_get_help_md', (module_id, answer) => {
			this.getHelpForModule(module_id)
				.then((res) => {
					if (res) {
						answer(null, res)
					} else {
						answer('nofile')
					}
				})
				.catch((err) => {
					this.debug(`Error loading help for ${module_id}`)
					this.debug(err)
					answer('nofile')
				})
		})
	}

	/**
	 * Load the help file for a specified module_id
	 * @param {string} module_id
	 */
	async getHelpForModule(module_id) {
		const moduleInfo = this.known_modules[module_id]
		if (moduleInfo && moduleInfo.helpPath) {
			const stats = await fs.stat(moduleInfo.helpPath)
			if (stats.isFile()) {
				const data = await fs.readFile(moduleInfo.helpPath)
				return {
					markdown: data.toString(),
					baseUrl: `/int/help/module/${module_id}/`,
				}
			} else {
				this.debug(`Error loading help for ${module_id}`, moduleInfo.helpPath)
				this.debug('Not a file')
				return undefined
			}
		} else {
			return undefined
		}
	}

	/**
	 * Load information about a module
	 * @access private
	 * @param {string} name - Name of the module
	 * @param {string} fullpath - Fullpath to the module
	 */
	loadInfoForModule(fullpath) {
		try {
			const manifestPath = path.join(fullpath, 'companion/manifest.json')
			if (!fs.pathExistsSync(manifestPath)) {
				this.debug(`Ignoring "${fullpath}", as it is not a new module`)
				return
			}
			const manifestJsonStr = fs.readFileSync(manifestPath)
			const manifestJson = JSON.parse(manifestJsonStr)

			// TODO - enable this
			// validateManifest(manifestJson)

			const helpPath = path.join(fullpath, 'companion/HELP.md')

			const hasHelp = fs.existsSync(helpPath)
			const moduleDisplay = {
				id: manifestJson.id,
				name: manifestJson.manufacturer + ':' + manifestJson.products.join(';'),
				version: manifestJson.version,
				hasHelp: hasHelp,
				bugUrl: manifestJson.repository,
				shortname: manifestJson.shortname,
				manufacturer: manifestJson.manufacturer,
				products: manifestJson.products,
				keywords: manifestJson.keywords,
			}

			const moduleManifestExt = {
				manifest: manifestJson,
				basePath: fullpath,
				helpPath: hasHelp ? helpPath : null,
				display: moduleDisplay,
			}

			this.known_modules[manifestJson.id] = moduleManifestExt

			// this.modules_main[name] = mainJsPath
			// this.package_info[name] = manifestJson

			this.debug(`found module ${moduleDisplay.id}@${moduleDisplay.version}`)
			this.system.emit(
				'log',
				`module-loader`,
				'debug',
				`${moduleDisplay.id}@${moduleDisplay.version}: ${moduleDisplay.name}`
			)
		} catch (e) {
			this.debug(`Error loading module from ${fullpath}`, e)
			this.system.emit('log', `module-loader`, 'error', 'Error loading module: ' + e)
		}
	}
}

module.exports = Instance
