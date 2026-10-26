export const APP_NAME = "ClusterRightHand";

export function appTitle(subtitle?: string): string {
	return subtitle ? `${APP_NAME} - ${subtitle}` : APP_NAME;
}
