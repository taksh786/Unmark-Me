// Sends the one-time sign-in code.
//
// With RESEND_API_KEY set, the code goes out through Resend. Without it, local
// development prints the code to the server log instead; deployed builds refuse
// to sign anyone in rather than silently dropping the email.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class EmailNotConfiguredError extends Error {}

function isDeployed() {
    return Boolean(process.env.VERCEL);
}

export async function sendLoginCode({ email, code, minutesValid }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        if (isDeployed()) {
            throw new EmailNotConfiguredError('RESEND_API_KEY is not set');
        }
        console.log(`\n✉️  Unmark Me sign-in code for ${email}: ${code}  (valid ${minutesValid} min)\n`);
        return;
    }

    const from = process.env.EMAIL_FROM || 'Unmark Me <onboarding@resend.dev>';
    const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from,
            to: [email],
            subject: `${code} is your Unmark Me code`,
            text: [
                `Your Unmark Me sign-in code is ${code}.`,
                '',
                `It expires in ${minutesValid} minutes. If you didn't ask for it, you can ignore this email.`
            ].join('\n')
        })
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend rejected the email (${response.status}): ${detail.slice(0, 200)}`);
    }
}
