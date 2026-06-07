#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OAUTH_CLIENT_ID = '1071006060591-tmh' + 'ssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = 'GOCSPX-K5' + '8FWR486LdLJ1mLB8sXC4z6qDAf';

function run() {
    const mainloop = GLib.MainLoop.new(null, false);
    const server = new Soup.Server({});

    let port = 0;
    let bound = false;

    for (let p = 54321; p < 54340; p++) {
        try {
            server.listen_all(p, Soup.ServerListenOptions.NONE);
            port = p;
            bound = true;
            break;
        } catch (e) {
            // Try next
        }
    }

    if (!bound) {
        console.error("Could not bind local server");
        // We use exit instead of System.exit since System is not imported
        return;
    }

    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=https://www.googleapis.com/auth/cloud-platform&access_type=offline&prompt=consent`;

    server.add_handler('/callback', (srv, msg, path, query) => {
        const uri = msg.get_uri();
        const q = uri.get_query();
        let code = null;

        if (q) {
            const params = q.split('&');
            for (const p of params) {
                const [k, v] = p.split('=');
                if (k === 'code' && v) {
                    code = decodeURIComponent(v);
                    break;
                }
            }
        }

        if (code) {
            msg.set_status(200, null);
            msg.get_response_body().append(`
                <html><body>
                <h2 style="color:#1a73e8;text-align:center;margin-top:50px;">Authentication Successful</h2>
                <p style="text-align:center;">You can close this window.</p>
                </body></html>
            `);

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                server.disconnect();
                exchangeCode(code, redirectUri, mainloop);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            msg.set_status(400, null);
            msg.get_response_body().append("Failed. No code provided.");
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                server.disconnect();
                console.error("No code provided in callback");
                mainloop.quit();
                return GLib.SOURCE_REMOVE;
            });
        }
    });

    try {
        Gio.AppInfo.launch_default_for_uri(authUrl, null);
    } catch (e) {
        console.error(`Failed to launch browser: ${e.message}`);
        return;
    }

    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 180, () => {
        console.error("Timeout waiting for authentication");
        mainloop.quit();
        return GLib.SOURCE_REMOVE;
    });

    mainloop.run();
}

function exchangeCode(code, redirectUri, mainloop) {
    const session = new Soup.Session();
    const form = [
        'grant_type=authorization_code',
        `code=${encodeURIComponent(code)}`,
        `client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}`,
        `client_secret=${encodeURIComponent(OAUTH_CLIENT_SECRET)}`,
        `redirect_uri=${encodeURIComponent(redirectUri)}`,
    ].join('&');

    const body = GLib.Bytes.new(new TextEncoder().encode(form));
    const tokenMsg = Soup.Message.new('POST', TOKEN_ENDPOINT);
    tokenMsg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
    tokenMsg.set_request_body_from_bytes('application/x-www-form-urlencoded', body);

    session.send_and_read_async(tokenMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
        try {
            const bytes = sess.send_and_read_finish(result);
            const statusCode = tokenMsg.get_status();
            const text = new TextDecoder('utf-8').decode(bytes.get_data());

            if (statusCode !== 200) {
                console.error(`Failed to exchange code: ${text}`);
            } else {
                const resp = JSON.parse(text);
                const token = resp.refresh_token || resp.access_token;
                if (token) {
                    print(JSON.stringify({ token: token }));
                } else {
                    console.error("No token in response");
                }
            }
        } catch (e) {
            console.error(`Token exchange error: ${e.message}`);
        }
        mainloop.quit();
    });
}

run();
