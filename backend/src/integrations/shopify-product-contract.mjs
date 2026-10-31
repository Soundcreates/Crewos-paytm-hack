/** Enforce catalog-only fields and exact currency shape before operation reservation. */
export function validateShopifyProductInput(input){
  const fail=()=>{throw Object.assign(new Error('Shopify product drafts require uppercase three-letter currency and do not support inventory or publication fields.'),{code:'invalid_tool_input',status:422});};
  if(!input||typeof input!=='object'||!Array.isArray(input.products))fail();
  for(const product of input.products){
    if(!product||Object.keys(product).some(key=>!['title','variants'].includes(key))||!Array.isArray(product.variants))fail();
    for(const variant of product.variants)if(!variant||Object.keys(variant).some(key=>!['sku','priceMinor','currency'].includes(key))||typeof variant.currency!=='string'||!/^[A-Z]{3}$/.test(variant.currency))fail();
  }
  return input;
}
