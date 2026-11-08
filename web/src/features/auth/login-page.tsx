import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { APP_NAME } from "@/app/meta";
import { ErrorText } from "@/components/error-state";
import { TextField } from "@/components/form";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loginErrorMessage, useLogin, useLoginOptions } from "@/features/auth/api";
import { safeRedirectPath } from "@/features/auth/redirect";
import { useAuth } from "@/features/auth/session";

interface LoginValues {
	username: string;
	password: string;
}

/**
 * The sign-in page. It keeps a deep link (an approval URL handed out over MCP,
 * for example) in the `redirect` search parameter and returns there after a
 * successful login.
 */
export function LoginPage() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const search = useSearch({ from: "/login" });
	const auth = useAuth();
	const login = useLogin();
	const loginOptions = useLoginOptions();
	const captcha = loginOptions.data?.captcha ?? "none";

	const schema = useMemo(
		() =>
			z.object({
				username: z.string().min(1, t`Enter your username.`),
				password: z.string().min(1, t`Enter your password.`),
			}),
		[t],
	);

	const form = useForm<LoginValues>({ resolver: zodResolver(schema), defaultValues: { username: "", password: "" } });

	useEffect(() => {
		document.title = `${t`Sign in`} · ${APP_NAME}`;
	}, [t]);

	useEffect(() => {
		if (auth.status === "authenticated") void navigate({ to: "/sessions", replace: true });
	}, [auth.status, navigate]);

	const submit = form.handleSubmit(async (values) => {
		await login.mutateAsync(
			{ ...values, captcha },
			{
				onSuccess: () => {
					const target = safeRedirectPath(search.redirect) ?? "/sessions";
					void navigate({ href: target, replace: true });
				},
			},
		);
	});

	return (
		<main className="grid min-h-svh place-items-center bg-background p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-lg">{APP_NAME}</CardTitle>
					<CardDescription>
						<Trans>Sign in to the operations console.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="grid gap-3" onSubmit={(event) => void submit(event)} noValidate>
						<TextField
							control={form.control}
							name="username"
							label={<Trans>Username</Trans>}
							autoComplete="username"
							autoFocus
						/>
						<TextField
							control={form.control}
							name="password"
							type="password"
							label={<Trans>Password</Trans>}
							autoComplete="current-password"
						/>
						{login.error !== null && <ErrorText error={loginErrorMessage(login.error) ?? login.error} />}
						<Button
							type="submit"
							disabled={login.isPending || loginOptions.isPending}
							className="mt-1"
							aria-busy={login.isPending || undefined}
						>
							{login.isPending && <Spinner className="size-4" decorative />}
							{login.isPending && captcha === "cap" ? <Trans>Running a security check…</Trans> : <Trans>Sign in</Trans>}
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
