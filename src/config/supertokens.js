import supertokens from "supertokens-node";
import EmailPassword from "supertokens-node/recipe/emailpassword/index.js";
import Passwordless from "supertokens-node/recipe/passwordless/index.js";
import Session from "supertokens-node/recipe/session/index.js";
import UserRoles from "supertokens-node/recipe/userroles/index.js";
import Dashboard from "supertokens-node/recipe/dashboard/index.js";
import { ensureLocalUserProfile } from "../services/userProfile.service.js";
import { markInviteAccepted } from "../services/invite.service.js";

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
                await ensureLocalUserProfile(response.user.id, getField("email"), "owner", {
                  firstName: getField("first_name"),
                  lastName: getField("last_name"),
                  phone: getField("phone"),
                });
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
