import type {
  IAuthenticateGeneric,
  Icon,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

/**
 * A Rasket API key, sent as `Authorization: Bearer rk_…`. An API key rather than OAuth: every
 * self-hosted n8n has its own redirect URL, and a key works the same on all of them.
 */
export class RasketApi implements ICredentialType {
  name = "rasketApi";

  displayName = "Rasket API";

  icon: Icon = { light: "file:rasket.svg", dark: "file:rasket.dark.svg" };

  documentationUrl = "https://www.rasket.com/docs/integrations/n8n#connect-your-rasket-account";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      required: true,
      default: "",
      placeholder: "e.g. rk_…",
      description:
        "Create a Full access API key in Rasket → API keys. To send texts, also set its SMS access to Send only (Send and manage to read them too). For Inbox events in the trigger, set Inbox access to Read.",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.apiKey}}",
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: "https://api.rasket.com",
      url: "/team",
      headers: { "User-Agent": "n8n-nodes-rasket" },
    },
  };
}
