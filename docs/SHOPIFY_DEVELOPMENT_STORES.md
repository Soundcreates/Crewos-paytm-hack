# Shopify development store previews

After each completed browser voice interview, CrewOS starts one separate Shopify development-store request using the selected category's store name. Each voice session has its own request, even for an existing workspace. The backend uses Shopify CLI with `SHOPIFY_DEV_ORGANIZATION_ID` and `SHOPIFY_DEV_STORE_PLAN`; `SHOPIFY_DEV_STORE_ENABLED=true` enables the route. Local development can use the backend user's existing Shopify CLI login. Headless deployments can set `SHOPIFY_SERVICE_ACCOUNT_TOKEN` with dev-store management permission for creation.

Once store creation is confirmed, CrewOS generates a category-specific theme and uploads it as a new **unpublished** theme using Shopify CLI. The preview URL is returned to the manager. Theme push uses the backend user's Shopify CLI login; a service-account token for store creation does not by itself configure theme access. Shopify may require additional theme permissions or an exemption. The development store may be password protected.

Requests are bound to the workspace, manager, and completed voice session. A durable unique record prevents a retry from creating another store or theme. If the CLI fails, times out, or returns an unverifiable result, the status becomes `uncertain`; inspect the Shopify dashboard before taking any further action. CrewOS never automatically retries an uncertain operation.

The generated theme displays products already present in Shopify. CrewOS does not upload the example catalog, publish the theme, or perform payment actions. Store category comes from the interview's user transcript when available; the manager can choose a different category before requesting the store.

## Requirements

- Shopify CLI installed on the backend host and authenticated to the intended organization.
- A numeric development organization ID and a supported plan (`basic`, `grow`, `advanced`, or `plus`).
- For headless store creation, a Shopify service account with dev-store management permission. Do not place its token in frontend configuration.
- Theme access for the backend CLI user on the created store. Check Shopify's current `write_themes` and exemption requirements before enabling theme API mutations.
- Shopify OAuth app configuration and the exact public callback if the manager chooses to connect the created store to CrewOS.
