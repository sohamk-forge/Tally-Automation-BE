import supertokens from "supertokens-node";
import EmailPassword from "supertokens-node/recipe/emailpassword/index.js";
import { SMTPService as EmailPasswordSMTPService } from "supertokens-node/recipe/emailpassword/emaildelivery/index.js";
import Passwordless from "supertokens-node/recipe/passwordless/index.js";
import Session from "supertokens-node/recipe/session/index.js";
import UserRoles from "supertokens-node/recipe/userroles/index.js";
import Dashboard from "supertokens-node/recipe/dashboard/index.js";
import { ensureLocalUserProfile } from "../services/userProfile.service.js";
import { markInviteAccepted } from "../services/invite.service.js";
import { sendSignupOtp } from "../services/otp.service.js";

export const initSupertokens = () => {
  supertokens.init({
    framework: "express",
    supertokens: {
      connectionURI: process.env.SUPERTOKENS_CONNECTION_URI,
      apiKey: process.env.SUPERTOKENS_API_KEY,
    },
    appInfo: {
      appName: "Tally Automation",
      apiDomain: process.env.API_DOMAIN,
      websiteDomain: process.env.FRONTEND_URL,
      apiBasePath: "/auth",
      websiteBasePath: "/login",
    },
    recipeList: [
      EmailPassword.init({
        // Powers the "Forgot password?" flow already linked from AuthPage
        // (/login/reset-password, handled by SuperTokens' default prebuilt
        // UI) — without this override, password-reset emails go through
        // SuperTokens' own hosted email service instead of our SMTP, same
        // gap the invite flow already worked around via mailer.service.js.
        emailDelivery: {
          service: new EmailPasswordSMTPService({
            smtpSettings: {
              host: process.env.SMTP_HOST,
              port: Number(process.env.SMTP_PORT) || 465,
              secure: Number(process.env.SMTP_PORT) === 465,
              authUsername: process.env.SMTP_USER,
              password: process.env.SMTP_PASSWORD,
              from: {
                name: process.env.SMTP_FROM_NAME || "Tally Automation",
                email: process.env.SMTP_USER,
              },
            },
            override: (originalImplementation) => ({
              ...originalImplementation,
              sendRawEmail: async (input) => {
                if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
                  console.log(`SMTP not configured — password reset email for ${input.toEmail} not sent (subject: ${input.subject})`);
                  return;
                }
                await originalImplementation.sendRawEmail(input);
              },
            }),
          }),
        },
        signUpFeature: {
          formFields: [
            { id: "first_name" },
            { id: "last_name" },
            {
              id: "phone",
              validate: async (value) => {
                if (!/^\d{10}$/.test(value)) {
                  return "Phone number must be exactly 10 digits";
                }
                return undefined;
              },
            },
          ],
        },
        override: {
          apis: (originalImplementation) => ({
            ...originalImplementation,
            signUpPOST: async (input) => {
              const response = await originalImplementation.signUpPOST(input);
              if (response.status === "OK") {
                const getField = (id) =>
                  input.formFields.find((f) => f.id === id)?.value ?? null;
                const email = getField("email");
                // Credentials-based signup — unlike the Passwordless invite
                // flow below, nothing here proves the user actually owns
                // this inbox yet, so gate on an emailed OTP before treating
                // the account as verified.
                await ensureLocalUserProfile(response.user.id, email, "owner", {
                  firstName: getField("first_name"),
                  lastName: getField("last_name"),
                  phone: getField("phone"),
                }, true, false);
                await sendSignupOtp(email);
              }
              return response;
            },
          }),
        },
      }),
      // Used only for the invite flow: invited team members log in via a
      // magic link rather than setting a password.
      Passwordless.init({
        contactMethod: "EMAIL",
        flowType: "MAGIC_LINK",
        override: {
          apis: (originalImplementation) => ({
            ...originalImplementation,
            consumeCodePOST: async (input) => {
              const response = await originalImplementation.consumeCodePOST(input);
              if (response.status === "OK") {
                const email = response.user.emails[0];
                // The recipe user (and its local profile) is normally created
                // up front by Passwordless.signInUp() when the invite is sent
                // (see invites.routes.js), so createdNewRecipeUser is already
                // false by the time the link is consumed. ensureLocalUserProfile
                // is idempotent (ON CONFLICT DO NOTHING), so calling it here
                // unconditionally also covers a user consuming a link without
                // ever having gone through the invite-send step.
                await ensureLocalUserProfile(response.user.id, email, "user", {}, false);
                await markInviteAccepted(response.user.id, email);
              }
              return response;
            },
          }),
        },
      }),
      UserRoles.init(),
      Dashboard.init(),
      Session.init({ tokenTransferMethod: "header" }),
    ],
  });
};
