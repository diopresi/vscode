/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Emitter } from '../../../../../base/common/event.js';
import { basename } from '../../../../../base/common/resources.js';
import { IChatRequestVariableEntry, isChatRequestFileEntry } from '../../common/chatModel.js';
import { ChatPromptAttachmentModel } from './chatPromptAttachmentModel.js';
import { PromptsConfig } from '../../../../../platform/prompts/common/config.js';
import { IPromptFileReference } from '../../common/promptSyntax/parsers/types.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

/**
 * Prompt IDs start with a well-defined prefix that is used by
 * the copilot extension to identify prompt references.
 *
 * @param uri The URI of the prompt file.
 * @param isRoot Whether the prompt file is the root file, or a
 *               child reference that is nested inside the root file.
 */
export const createPromptVariableId = (
	uri: URI,
	isRoot: boolean,
): string => {
	// the default prefix that is used for all prompt files
	let prefix = 'vscode.prompt.instructions';
	// if the reference is the root object, add the `.root` suffix
	if (isRoot) {
		prefix += '.root';
	}

	// final `id` for all `prompt files` starts with the well-defined
	// part that the copilot extension(or other chatbot) can rely on
	return `${prefix}__${uri}`;
};

/**
 * Utility to convert a {@link reference} to a chat variable entry.
 * The `id` of the chat variable can be one of the following:
 *
 * - `vscode.prompt.instructions__<URI>`: for all non-root prompt file references
 * - `vscode.prompt.instructions.root__<URI>`: for *root* prompt file references
 * - `<URI>`: for the rest of references(the ones that do not point to a prompt file)
 *
 * @param reference A reference object to convert to a chat variable entry.
 * @param isRoot If the reference is the root reference in the references tree.
 * 				 This object most likely was explicitly attached by the user.
 */
export const toChatVariable = (
	reference: Pick<IPromptFileReference, 'uri' | 'isPromptFile'>,
	isRoot: boolean,
): IChatRequestVariableEntry => {
	const { uri, isPromptFile } = reference;

	// default `id` is the stringified `URI`
	let id = `${uri}`;

	// prompts have special `id`s that are used by the copilot extension
	if (isPromptFile) {
		id = createPromptVariableId(uri, isRoot);
	}

	const name = (isPromptFile)
		? `prompt:${basename(uri)}`
		: `file:${basename(uri)}`;

	const modelDescription = (isPromptFile)
		? 'Prompt instructions file'
		: undefined;

	return {
		id,
		name,
		value: uri,
		kind: 'file',
		modelDescription,
	};
};

export function isPromptFileChatVariable(variable: IChatRequestVariableEntry): boolean {
	return isChatRequestFileEntry(variable) && variable.name.startsWith('prompt:');
}

/**
 * Model for a collection of prompt instruction attachments.
 * See {@linkcode ChatPromptAttachmentModel} for individual attachment.
 */
export class ChatPromptAttachmentsCollection extends Disposable {
	/**
	 * Event that fires then this model is updated.
	 *
	 * See {@linkcode onUpdate}.
	 */
	protected _onUpdate = this._register(new Emitter<void>());
	/**
	 * Subscribe to the `onUpdate` event.
	 */
	public onUpdate = this._onUpdate.event;

	/**
	 * Event that fires when a new prompt instruction attachment is added.
	 * See {@linkcode onAdd}.
	 */
	protected _onAdd = this._register(new Emitter<ChatPromptAttachmentModel>());
	/**
	 * The `onAdd` event fires when a new prompt instruction attachment is added.
	 */
	public onAdd = this._onAdd.event;

	/**
	 * Event that fires when a new prompt instruction attachment is removed.
	 * See {@linkcode onRemove}.
	 */
	protected _onRemove = this._register(new Emitter<ChatPromptAttachmentModel>());
	/**
	 * The `onRemove` event fires when a new prompt instruction attachment is removed.
	 */
	public onRemove = this._onRemove.event;

	/**
	 * List of all prompt instruction attachments.
	 */
	private attachments: DisposableMap<string, ChatPromptAttachmentModel> =
		this._register(new DisposableMap());

	/**
	 * Get all `URI`s of all valid references, including all
	 * the possible references nested inside the children.
	 */
	public get references(): readonly URI[] {
		const result = [];

		for (const child of this.attachments.values()) {
			result.push(...child.references);
		}

		return result;
	}

	/**
	 * Get the list of all prompt instruction attachment variables, including all
	 * nested child references of each attachment explicitly attached by user.
	 */
	public get chatAttachments(): readonly IChatRequestVariableEntry[] {
		const result = [];
		const attachments = [...this.attachments.values()];

		for (const attachment of attachments) {
			const { reference } = attachment;

			// the usual URIs list of prompt instructions is `bottom-up`, therefore
			// we do the same here - first add all child references of the model
			result.push(
				...reference.allValidReferences.map((link) => {
					return toChatVariable(link, false);
				}),
			);

			// then add the root reference of the model itself
			result.push(
				toChatVariable({
					uri: reference.uri,
					// the attached file must have been a prompt file therefore
					// we force that assumption here; this makes sure that prompts
					// in untitled documents can be also attached to the chat input
					isPromptFile: true,
				}, true),
			);
		}

		return result;
	}

	/**
	 * Promise that resolves when parsing of all attached prompt instruction
	 * files completes, including parsing of all its possible child references.
	 */
	public async allSettled(): Promise<void> {
		const attachments = [...this.attachments.values()];

		await Promise.allSettled(
			attachments.map((attachment) => {
				return attachment.allSettled;
			}),
		);
	}

	constructor(
		@IInstantiationService private readonly initService: IInstantiationService,
		@IConfigurationService private readonly configService: IConfigurationService,
	) {
		super();

		this._onUpdate.fire = this._onUpdate.fire.bind(this._onUpdate);
	}

	/**
	 * Add a prompt instruction attachment instance with the provided `URI`.
	 * @param uri URI of the prompt instruction attachment to add.
	 *
	 * @returns `true` if the attachment already exists, `false` otherwise.
	 */
	public add(uri: URI): boolean {
		// if already exists, nothing to do
		if (this.attachments.has(uri.path)) {
			return true;
		}

		const instruction = this.initService.createInstance(ChatPromptAttachmentModel, uri)
			.onUpdate(this._onUpdate.fire)
			.onDispose(() => {
				// note! we have to use `deleteAndLeak` here, because the `*AndDispose`
				//       alternative results in an infinite loop of calling this callback
				this.attachments.deleteAndLeak(uri.path);
				this._onUpdate.fire();
				this._onRemove.fire(instruction);
			});

		this.attachments.set(uri.path, instruction);
		instruction.resolve();

		this._onAdd.fire(instruction);
		this._onUpdate.fire();

		return false;
	}

	/**
	 * Remove a prompt instruction attachment instance by provided `URI`.
	 * @param uri URI of the prompt instruction attachment to remove.
	 */
	public remove(uri: URI): this {
		// if does not exist, nothing to do
		if (!this.attachments.has(uri.path)) {
			return this;
		}

		this.attachments.deleteAndDispose(uri.path);

		return this;
	}

	/**
	 * Checks if the prompt instructions feature is enabled in the user settings.
	 */
	public get featureEnabled(): boolean {
		return PromptsConfig.enabled(this.configService);
	}
}
