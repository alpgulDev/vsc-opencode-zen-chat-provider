declare module 'vscode' {
	export interface LanguageModelChatInformation {
		readonly isBYOK?: boolean;
		readonly isUserSelectable?: boolean;
		readonly targetChatSessionType?: string;
	}
}
