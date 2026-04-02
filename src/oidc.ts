import * as core from '@actions/core';
import { HttpClient } from '@actions/http-client';

export async function getOidcToken(audience: string): Promise<string> {
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

  if (!requestToken || !requestUrl) {
    throw new Error(
      'OIDC token not available. Add "permissions: id-token: write" to your job.'
    );
  }

  const http = new HttpClient('kobe-action');
  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await http.getJson<{ value: string }>(url, {
    Authorization: `bearer ${requestToken}`,
  });

  if (!response.result?.value) {
    throw new Error('Failed to obtain OIDC token from GitHub');
  }

  core.setSecret(response.result.value);
  return response.result.value;
}
