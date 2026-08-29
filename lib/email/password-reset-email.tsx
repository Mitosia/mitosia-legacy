import type { CSSProperties } from "react";

const WHITESPACE = /\s+/;

interface PasswordResetEmailProps {
  name: string;
  resetUrl: string;
}

export function PasswordResetEmail({
  name,
  resetUrl,
}: PasswordResetEmailProps) {
  const firstName = name.trim().split(WHITESPACE)[0] || "there";

  return (
    <html lang="en">
      <head>
        <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <title>Reset your Mitosia password</title>
      </head>
      <body style={styles.body}>
        <div style={styles.preview}>
          Use this secure link to choose a new Mitosia password.
        </div>
        <table
          cellPadding="0"
          cellSpacing="0"
          role="presentation"
          style={styles.shell}
          width="100%"
        >
          <tbody>
            <tr>
              <td align="center">
                <table
                  cellPadding="0"
                  cellSpacing="0"
                  role="presentation"
                  style={styles.card}
                  width="100%"
                >
                  <tbody>
                    <tr>
                      <td style={styles.content}>
                        <p style={styles.wordmark}>MITOSIA</p>
                        <h1 style={styles.heading}>Choose a new password</h1>
                        <p style={styles.paragraph}>Hi {firstName},</p>
                        <p style={styles.paragraph}>
                          A password reset was requested for your Mitosia
                          account. Use the secure link below to choose a new
                          password.
                        </p>
                        <p style={styles.buttonRow}>
                          <a href={resetUrl} style={styles.button}>
                            Reset password
                          </a>
                        </p>
                        <p style={styles.notice}>
                          This link expires in one hour and can only be used
                          once. If you did not request it, you can ignore this
                          email; your password will not change.
                        </p>
                        <hr style={styles.rule} />
                        <p style={styles.fallbackLabel}>
                          Button not working? Copy this link into your browser:
                        </p>
                        <p style={styles.fallbackLink}>{resetUrl}</p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

const styles = {
  body: {
    backgroundColor: "#f5f5f5",
    color: "#252525",
    fontFamily:
      "Google Sans, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    margin: 0,
    padding: "32px 16px",
  },
  button: {
    backgroundColor: "#252525",
    borderRadius: "12px",
    color: "#ffffff",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: 600,
    padding: "12px 20px",
    textDecoration: "none",
  },
  buttonRow: {
    margin: "28px 0",
  },
  card: {
    backgroundColor: "#ffffff",
    border: "1px solid #e7e7e7",
    borderRadius: "20px",
    maxWidth: "520px",
  },
  content: {
    padding: "36px",
  },
  fallbackLabel: {
    color: "#696969",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 6px",
  },
  fallbackLink: {
    color: "#696969",
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
    overflowWrap: "anywhere",
  },
  heading: {
    fontSize: "26px",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    lineHeight: "32px",
    margin: "18px 0 22px",
  },
  notice: {
    color: "#696969",
    fontSize: "13px",
    lineHeight: "20px",
    margin: 0,
  },
  paragraph: {
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 12px",
  },
  preview: {
    display: "none",
    maxHeight: 0,
    maxWidth: 0,
    opacity: 0,
    overflow: "hidden",
  },
  rule: {
    border: 0,
    borderTop: "1px solid #e7e7e7",
    margin: "28px 0 22px",
  },
  shell: {
    margin: "0 auto",
    maxWidth: "520px",
  },
  wordmark: {
    color: "#696969",
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.16em",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
