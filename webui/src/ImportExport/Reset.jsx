import React, { forwardRef, useCallback, useContext, useImperativeHandle, useState } from 'react'
import {
	CButton,
	CForm,
	CModal,
	CModalBody,
	CModalFooter,
	CModalHeader,
	CAlert,
	CInputCheckbox,
	CLabel,
} from '@coreui/react'
import { NotifierContext, SocketContext, socketEmitPromise } from '../util'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDownload } from '@fortawesome/free-solid-svg-icons'

export const ResetWizardModal = forwardRef(function WizardModal(_props, ref) {
	const socket = useContext(SocketContext)
	const notifier = useContext(NotifierContext)

	const [currentStep, setCurrentStep] = useState(1)
	const maxSteps = 3
	const applyStep = 3
	const [clear, setClear] = useState(true)
	const [show, setShow] = useState(false)
	const [config, setConfig] = useState({})

	const doClose = useCallback(() => {
		setShow(false)
		setClear(true)
	}, [])

	const doNextStep = useCallback(() => {
		let newStep = currentStep
		// Make sure step is set to something reasonable
		if (newStep >= maxSteps - 1) {
			newStep = maxSteps
		} else {
			newStep = newStep + 1
		}

		setCurrentStep(newStep)
	}, [currentStep, maxSteps])

	const doPrevStep = useCallback(() => {
		let newStep = currentStep
		if (newStep <= 1) {
			newStep = 1
		} else {
			newStep = newStep - 1
		}

		setCurrentStep(newStep)
	}, [currentStep])

	const doSave = useCallback(
		(e) => {
			e.preventDefault()

			socketEmitPromise(socket, 'loadsave:reset', [config], 30000)
				.then((status) => {
					if (status !== 'ok') {
						notifier.current.show(
							`Reset failed`,
							`An unspecified error occurred during the reset.  Please try again.`,
							10000
						)
					}

					doNextStep()
				})
				.catch((e) => {
					notifier.current.show(`Reset failed`, 'An error occurred:' + e, 10000)
					doNextStep()
				})

			doNextStep()
		},
		[socket, notifier, config, doNextStep]
	)

	const setValue = (key, value) => {
		setConfig((oldState) => ({
			...oldState,
			[key]: value,
		}))
	}

	useImperativeHandle(
		ref,
		() => ({
			show() {
				if (clear) {
					setConfig({
						connections: true,
						buttons: true,
						surfaces: true,
						triggers: true,
						customVariables: true,
						userconfig: true,
					})

					setCurrentStep(1)
				}
				setShow(true)
				setClear(false)
			},
		}),
		[clear]
	)

	let nextButton
	switch (currentStep) {
		case applyStep:
			nextButton = (
				<CButton color="primary" onClick={doSave}>
					Apply
				</CButton>
			)
			break
		case maxSteps:
			nextButton = (
				<CButton color="primary" onClick={doClose}>
					Finish
				</CButton>
			)
			break
		default:
			nextButton = (
				<CButton color="primary" onClick={doNextStep}>
					Next
				</CButton>
			)
	}

	let modalBody
	switch (currentStep) {
		case 1:
			modalBody = <ResetBeginStep />
			break
		case 2:
			modalBody = <ResetOptionsStep config={config} setValue={setValue} />
			break
		case 3:
			modalBody = <ResetApplyStep config={config} />
			break
		default:
	}

	return (
		<CModal show={show} onClose={doClose} className={'wizard'} closeOnBackdrop={false}>
			<CForm className={'edit-button-panel'}>
				<CModalHeader>
					<h2>
						<img src="/img/icons/48x48.png" height="30" alt="logo" />
						Reset Configuration
					</h2>
				</CModalHeader>
				<CModalBody>{modalBody}</CModalBody>
				<CModalFooter>
					{currentStep <= applyStep && (
						<>
							<CButton color="secondary" onClick={doClose}>
								Cancel
							</CButton>
							<CButton color="secondary" disabled={currentStep === 1} onClick={doPrevStep}>
								Back
							</CButton>
						</>
					)}
					{nextButton}
				</CModalFooter>
			</CForm>
		</CModal>
	)
})

function ResetBeginStep() {
	return (
		<div>
			<p style={{ marginTop: 0 }}>
				Proceeding will allow you to reset some or all major components of this Companion installation.
			</p>
			<p>It is recommended to export the system configuration first.</p>

			<CButton color="success" href="/int/export/full" target="_new">
				<FontAwesomeIcon icon={faDownload} /> Export
			</CButton>
		</div>
	)
}

function ResetOptionsStep({ config, setValue }) {
	return (
		<div>
			<h5>Reset Options</h5>
			<p>Please select the components you'd like to reset.</p>
			<div className="indent3">
				<div className="form-check form-check-inline mr-1">
					<CInputCheckbox
						id="wizard_connections"
						checked={config.connections}
						onChange={(e) => setValue('connections', e.currentTarget.checked)}
					/>
					<CLabel htmlFor="wizard_connections">Connections</CLabel>
				</div>
				{config.connections && !(config.buttons && config.triggers) ? (
					<CAlert color="warning">
						Resetting 'Connections' will remove all actions, feedbacks, and triggers associated with the connections
						even if 'Buttons' and/or 'Triggers' are not also reset.
					</CAlert>
				) : (
					''
				)}
			</div>
			<div className="indent3">
				<div className="form-check form-check-inline mr-1">
					<CInputCheckbox
						id="wizard_buttons"
						checked={config.buttons}
						onChange={(e) => setValue('buttons', e.currentTarget.checked)}
					/>
					<CLabel htmlFor="wizard_buttons">Buttons</CLabel>
				</div>
			</div>
			<div className="indent3">
				<div className="form-check form-check-inline mr-1">
					<CInputCheckbox
						id="wizard_triggers"
						checked={config.triggers}
						onChange={(e) => setValue('triggers', e.currentTarget.checked)}
					/>
					<CLabel htmlFor="wizard_triggers">Triggers</CLabel>
				</div>
			</div>
			<div className="indent3">
				<div className="form-check form-check-inline mr-1">
					<CInputCheckbox
						id="wizard_custom_variables"
						checked={config.customVariables}
						onChange={(e) => setValue('customVariables', e.currentTarget.checked)}
					/>
					<CLabel htmlFor="wizard_custom_variables">Custom Variables</CLabel>
				</div>
				{config.customVariables && !(config.buttons && config.triggers) ? (
					<CAlert color="warning">
						Resetting 'Custom Variables' without also resetting 'Buttons', and 'Triggers' that may utilize them can
						create an unstable environment.
					</CAlert>
				) : (
					''
				)}
			</div>
			<div className="indent3">
				<div className="form-check form-check-inline mr-1">
					<CInputCheckbox
						id="wizard_surfaces"
						checked={config.surfaces}
						onChange={(e) => setValue('surfaces', e.currentTarget.checked)}
					/>
					<CLabel htmlFor="wizard_surfaces">Surfaces</CLabel>
				</div>
			</div>
			<div className="indent3">
				<div className="form-check form-check-inline mr-1">
					<CInputCheckbox
						id="wizard_userconfig"
						checked={config.userconfig}
						onChange={(e) => setValue('userconfig', e.currentTarget.checked)}
					/>
					<CLabel htmlFor="wizard_userconfig">Settings</CLabel>
				</div>
			</div>
		</div>
	)
}

function ResetApplyStep({ config }) {
	const changes = []

	if (config.connections && !config.buttons && !config.triggers) {
		changes.push(<li key="connections">All connections including their actions, feedbacks, and triggers.</li>)
	} else if (config.connections && !config.buttons) {
		changes.push(<li key="connections">All connections including their button actions and feedbacks.</li>)
	} else if (config.connections && !config.triggers) {
		changes.push(<li key="connections">All connections including their triggers and trigger actions.</li>)
	} else if (config.connections) {
		changes.push(<li key="connections">All connections.</li>)
	}

	if (config.buttons) {
		changes.push(<li key="buttons">All button styles, actions, and feedbacks.</li>)
	}

	if (config.surfaces) {
		changes.push(<li key="surfaces">All surface settings.</li>)
	}

	if (config.triggers) {
		changes.push(<li key="triggers">All triggers.</li>)
	}

	if (config.customVariables) {
		changes.push(<li key="custom-variables">All custom variables.</li>)
	}

	if (config.userconfig) {
		changes.push(<li key="userconfig">All settings, including enabled remote control services.</li>)
	}

	if (changes.length === 0) {
		changes.push(<li key="no-change">No changes to the configuration will be made.</li>)
	}

	return (
		<div>
			<h5>Review Changes</h5>
			<p>The following data will be reset:</p>
			<ul>{changes}</ul>
			{changes.length > 0 ? <CAlert color="danger">Proceeding will permanently clear the above data.</CAlert> : ''}
		</div>
	)
}
