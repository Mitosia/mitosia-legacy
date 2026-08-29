import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const query = await searchParams;
  const token = firstQueryValue(query.token);
  const hasTokenError = firstQueryValue(query.error) === "INVALID_TOKEN";

  return <ResetPasswordForm token={hasTokenError ? null : (token ?? null)} />;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
