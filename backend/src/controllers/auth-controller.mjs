export function createAuthController(dependencies) {
  const {
    repositories,
    HttpError,
    neonAuthEnabled,
    normalizeEmail,
    cleanString,
    validateOrgName,
    now,
    transaction,
    hashPassword,
    id,
    seedOrganization,
    isDuplicateSignupEmail,
    setSession,
    ensureNeonUser,
    requireNeonIdentity,
    createNeonWorkspace,
    loginFailures,
    passwordMatches,
    parseCookie,
    appSessionCookie,
    sha,
    traceStep,
    cookieHeader,
    sessionDays,
    randomBytes,
    event,
    appendSetCookies,
    mustAuth,
    sendJson,
    initializeChiefSession = async () => {},
  } = dependencies;

  return {
    async handle({ path, method, request, response, body, context, neonSession }) {
      if (path === '/api/auth/signup-intent' && method === 'POST') {
        if (!neonAuthEnabled) throw new HttpError(404, 'Neon Auth is not configured.');
        if (context) throw new HttpError(409, 'You are already signed in.');

        const email = normalizeEmail(body.email);
        const name = cleanString(body.name, 'Your name', 100);
        const organization = validateOrgName(body.organization);
        const timestamp = now();
        await repositories.auth.deleteSignupIntentByExpiresAt(timestamp);
        await repositories.auth.insertSignupIntent(
          email,
          name,
          organization,
          new Date(Date.now() + 7 * 86400000).toISOString(),
          timestamp,
        );
        sendJson(response, 200, { ok: true });
        return true;
      }

      if (path === '/api/auth/signup' && method === 'POST') {
        if (context) throw new HttpError(409, 'You are already signed in.');

        if (neonAuthEnabled) {
          const identity = requireNeonIdentity(neonSession);
          const email = normalizeEmail(body.email ?? identity.email);
          if (email !== normalizeEmail(identity.email)) {
            throw new HttpError(403, 'The signed-in Neon Auth email must match the workspace owner email.', 'identity_email_mismatch');
          }
          const intent = await repositories.auth.findOneSignupIntentByEmailAndExpiresAt(email, now());
          if (!intent) throw new HttpError(400, 'Workspace setup expired. Create the workspace again to continue.', 'signup_intent_expired');

          const user = await ensureNeonUser({ ...identity, name: intent.name });
          if (await repositories.auth.findOneMembershipByUserId(user.id)) {
            throw new HttpError(409, 'This Neon Auth account already belongs to a workspace. Sign in instead.', 'workspace_exists');
          }
          const organization = await createNeonWorkspace(user, intent);
          await setSession(response, user.id, organization.id, request);
          sendJson(response, 201, { user, organization });
          return true;
        }

        const name = cleanString(body.name, 'Your name', 100);
        const email = normalizeEmail(body.email);
        const orgName = validateOrgName(body.organization);
        if (await repositories.auth.findOneUserByEmailSelectId(email)) {
          throw new HttpError(409, 'An account already uses that email. Sign in or accept an invitation.');
        }

        const password = hashPassword(body.password);
        const orgId = id('org');
        const userId = id('user');
        const timestamp = now();
        try {
          await transaction(async () => {
            await repositories.auth.insertOrganization(orgId, orgName, timestamp);
            await repositories.auth.insertUserWithIdNameEmail(userId, name, email, password.salt, password.hash, timestamp);
            await repositories.auth.insertMembership(orgId, userId, 'owner', timestamp);
            await initializeChiefSession(orgId, userId, timestamp);
            await seedOrganization(orgId);
          });
        } catch (error) {
          if (isDuplicateSignupEmail(error)) {
            throw new HttpError(409, 'An account already uses that email. Sign in or accept an invitation.');
          }
          throw error;
        }

        await setSession(response, userId, orgId, request);
        await event(orgId, 'organization.created', { name: orgName }, { user: { id: userId } });
        sendJson(response, 201, {
          user: { id: userId, name, email },
          organization: { id: orgId, name: orgName, role: 'owner' },
        });
        return true;
      }

      if (path === '/api/auth/login' && method === 'POST') {
        if (neonAuthEnabled) {
          const identity = requireNeonIdentity(neonSession);
          const email = normalizeEmail(body.email ?? identity.email);
          if (email !== normalizeEmail(identity.email)) {
            throw new HttpError(403, 'The signed-in Neon Auth email does not match this account.', 'identity_email_mismatch');
          }

          const account = await ensureNeonUser(identity);
          let memberships = await repositories.auth.findManyMembershipByUserId(account.id);
          if (!memberships.length) {
            const intent = await repositories.auth.findOneSignupIntentByEmailAndExpiresAt(email, now());
            if (intent) {
              const user = account.name ? account : { ...account, name: intent.name };
              const organization = await createNeonWorkspace(user, intent);
              memberships = [{ org_id: organization.id, role: organization.role, name: organization.name }];
            }
          }
          if (!memberships.length) {
            throw new HttpError(403, 'This account has no workspace yet. Create one or accept a workspace invitation.', 'no_workspace');
          }

          await repositories.auth.deleteSignupIntentByEmail(email);
          await setSession(response, account.id, memberships[0].org_id, request);
          sendJson(response, 200, {
            user: account,
            organization: { id: memberships[0].org_id, name: memberships[0].name, role: memberships[0].role },
          });
          return true;
        }

        const ip = request.socket.remoteAddress || 'local';
        const failures = loginFailures.get(ip) || { count: 0, since: Date.now() };
        if (Date.now() - failures.since > 15 * 60 * 1000) {
          failures.count = 0;
          failures.since = Date.now();
        }
        if (failures.count >= 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');

        const email = normalizeEmail(body.email);
        const account = await repositories.auth.findOneUserByEmailSelectAllFields(email);
        if (!account || !passwordMatches(String(body.password ?? ''), account.password_salt, account.password_hash)) {
          failures.count += 1;
          loginFailures.set(ip, failures);
          throw new HttpError(401, 'Email or password is incorrect.', 'invalid_credentials');
        }

        loginFailures.delete(ip);
        const memberships = await repositories.auth.findManyMembershipByUserId(account.id);
        if (!memberships.length) throw new HttpError(403, 'This account is not a member of an organization.');
        await setSession(response, account.id, memberships[0].org_id, request);
        sendJson(response, 200, {
          user: { id: account.id, name: account.name, email: account.email },
          organization: { id: memberships[0].org_id, name: memberships[0].name, role: memberships[0].role },
        });
        return true;
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        const token = parseCookie(request.headers.cookie, appSessionCookie);
        const result = token
          ? await repositories.auth.deleteSessionByTokenHash(sha(token))
          : { changes: 0 };
        traceStep('auth.app_session.revoked', { cookiePresent: Boolean(token), sessionDeleted: result.changes > 0 });
        response.setHeader('Set-Cookie', cookieHeader('', 0, request));
        sendJson(response, 200, { ok: true });
        return true;
      }

      if (path === '/api/invitations/accept' && method === 'POST') {
        const token = cleanString(body.token, 'Invitation token', 200);
        let sessionToken = null;
        const accepted = await transaction(async () => {
          const timestamp = now();
          const invitation = await repositories.auth.findOneInvitationByTokenHashAndAcceptedAtAndExpiresAt(
            timestamp,
            sha(token),
            timestamp,
          );
          if (!invitation) throw new HttpError(404, 'Invitation is invalid or expired.');
          if (!['admin', 'manager', 'member'].includes(invitation.role)) {
            throw new HttpError(409, 'This invitation has an invalid workspace role. Ask an admin to create a new invitation.');
          }

          const normalized = normalizeEmail(invitation.email);
          let user;
          if (neonAuthEnabled) {
            const identity = requireNeonIdentity(neonSession);
            if (normalizeEmail(identity.email) !== normalized) {
              throw new HttpError(403, 'Sign in with the email address that received this invitation.', 'invitation_email_mismatch');
            }
            user = await ensureNeonUser(identity);
            if (context && context.user.id !== user.id) {
              throw new HttpError(401, 'Sign in with the invited email, then accept the invitation.');
            }
          } else {
            user = await repositories.auth.findOneUserByEmailSelectIdNameEmail(normalized);
            if (user) {
              if (!context || context.user.id !== user.id) {
                throw new HttpError(401, 'Sign in with the invited email, then accept the invitation.');
              }
            } else {
              if (context) throw new HttpError(401, 'Sign out and create an account with the invited email to accept this invitation.');
              const name = cleanString(body.name, 'Your name', 100);
              const password = hashPassword(body.password);
              const userId = id('user');
              await repositories.auth.insertUserWithIdNameEmail(userId, name, normalized, password.salt, password.hash, timestamp);
              user = { id: userId, name, email: normalized };
            }
          }

          await repositories.auth.insertMembershipWithOrgIdUserIdRole(invitation.org_id, user.id, invitation.role, timestamp);
          if (context) {
            const updated = await repositories.auth.updateSessionByTokenHashAndUserIdAndExpiresAt(
              invitation.org_id,
              context.tokenHash,
              user.id,
              timestamp,
            );
            if (updated.changes !== 1) {
              throw new HttpError(401, 'Your session expired. Sign in again, then accept the invitation.');
            }
          } else {
            sessionToken = randomBytes(32).toString('base64url');
            await repositories.auth.insertSession(
              sha(sessionToken),
              user.id,
              invitation.org_id,
              new Date(Date.now() + sessionDays * 86400000).toISOString(),
              timestamp,
            );
          }

          await event(invitation.org_id, 'member.joined', { email: normalized, role: invitation.role }, { user: { id: user.id } });
          return { organizationId: invitation.org_id };
        });

        if (sessionToken) appendSetCookies(response, [cookieHeader(sessionToken, sessionDays * 86400, request)]);
        sendJson(response, 200, { ok: true, organizationId: accepted.organizationId });
        return true;
      }

      if (path === '/api/auth/me' && method === 'GET') {
        if (!context) {
          sendJson(response, 200, { user: null, organization: null, organizations: [] });
          return true;
        }
        const organizations = await repositories.auth.findManyMembershipByUserIdSelectIdNameRole(context.user.id);
        sendJson(response, 200, { user: context.user, organization: context.org, organizations });
        return true;
      }

      if (path === '/api/org/switch' && method === 'POST') {
        mustAuth(context);
        const orgId = cleanString(body.organizationId, 'Organization', 120);
        const membership = await repositories.auth.findOneOrganizationByUserIdAndId(context.user.id, orgId);
        if (!membership) throw new HttpError(403, 'You are not a member of that organization.');
        await repositories.auth.updateSessionByTokenHash(orgId, context.tokenHash);
        sendJson(response, 200, { organization: { id: membership.id, name: membership.name, role: membership.role } });
        return true;
      }

      return false;
    },
  };
}
