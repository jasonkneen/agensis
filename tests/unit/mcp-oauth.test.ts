import { describe, expect, it } from 'vitest';
import {
  authorizationServerMetadata,
  buildAuthorizeRedirect,
  createAccessToken,
  isOauthAccessToken,
  normalizeScopes,
  protectedResourceMetadata,
  verifyPkceS256,
  sha256Base64Url,
  wwwAuthenticateHeader,
  mcpResourceUrl,
} from '../../shared/mcp-oauth.cjs';

describe('mcp-oauth pure helpers', () => {
  it('builds AS metadata with code + S256 PKCE endpoints', () => {
    const meta = authorizationServerMetadata('https://mcp.example.test');
    expect(meta.authorization_endpoint).toBe('https://mcp.example.test/backend/oauth/authorize');
    expect(meta.token_endpoint).toBe('https://mcp.example.test/backend/oauth/token');
    expect(meta.registration_endpoint).toContain('/backend/oauth/register');
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.grant_types_supported).toContain('authorization_code');
    expect(meta.scopes_supported).toContain('mcp:tools');
  });

  it('builds protected resource metadata pointing at MCP resource URL', () => {
    const prm = protectedResourceMetadata('https://mcp.example.test');
    expect(prm.resource).toBe(mcpResourceUrl('https://mcp.example.test'));
    expect(prm.authorization_servers).toEqual(['https://mcp.example.test']);
    expect(prm.scopes_supported).toContain('mcp:tools');
  });

  it('WWW-Authenticate advertises resource_metadata URL', () => {
    const h = wwwAuthenticateHeader('https://mcp.example.test');
    expect(h).toMatch(/resource_metadata=/);
    expect(h).toMatch(/oauth-protected-resource/);
  });

  it('verifies PKCE S256 correctly and rejects wrong verifier', () => {
    const verifier = 'a'.repeat(43);
    const challenge = sha256Base64Url(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256('b'.repeat(43), challenge)).toBe(false);
    expect(verifyPkceS256('', challenge)).toBe(false);
  });

  it('normalizes scopes to the closed allowlist', () => {
    expect(normalizeScopes('mcp:tools openid')).toEqual(['mcp:tools']);
    expect(normalizeScopes('')).toEqual(['mcp:tools']);
  });

  it('tags OAuth access tokens with ago_ prefix', () => {
    const tok = createAccessToken();
    expect(isOauthAccessToken(tok)).toBe(true);
    expect(isOauthAccessToken('agw_legacy')).toBe(false);
  });

  it('builds authorize redirect with code and state', () => {
    const url = buildAuthorizeRedirect({
      redirectUri: 'http://127.0.0.1/callback',
      code: 'abc',
      state: 'xyz',
    });
    expect(url).toContain('code=abc');
    expect(url).toContain('state=xyz');
  });
});
