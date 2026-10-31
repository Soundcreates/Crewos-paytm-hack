export const DEMO_STORES = Object.freeze({
  footwear: {
    id: 'footwear', name: 'Stride & Co.', category: 'Shoes and footwear', domain: 'strideco.myshopify.com', avatar: 'S',
    orderId: 'ST-2048', customer: 'Taylor',
    products: [
      { name: 'Stride Run One', sku: 'STR-RUN-001', price: '$129.00', stock: '18 pairs in stock' },
      { name: 'City Walk Low', sku: 'STR-WLK-014', price: '$89.00', stock: '26 pairs in stock' },
      { name: 'Trail Grip Mid', sku: 'STR-TRL-008', price: '$149.00', stock: '11 pairs in stock' },
    ],
  },
  clothing: {
    id: 'clothing', name: 'Threadline Studio', category: 'Clothing and apparel', domain: 'threadline-studio.myshopify.com', avatar: 'T',
    orderId: 'TH-1182', customer: 'Taylor',
    products: [
      { name: 'Everyday Cotton Tee', sku: 'TH-TEE-001', price: '$34.00', stock: '42 pieces in stock' },
      { name: 'Relaxed Linen Shirt', sku: 'TH-LIN-006', price: '$78.00', stock: '19 pieces in stock' },
      { name: 'Studio Work Jacket', sku: 'TH-JKT-011', price: '$145.00', stock: '9 pieces in stock' },
    ],
  },
  bags: {
    id: 'bags', name: 'CarryLab', category: 'Laptop bags and carry goods', domain: 'carrylab.myshopify.com', avatar: 'C',
    orderId: 'CL-3307', customer: 'Taylor',
    products: [
      { name: 'Transit 16-inch Laptop Bag', sku: 'CL-TRANSIT-16', price: '$118.00', stock: '23 bags in stock' },
      { name: 'Everyday Tech Tote', sku: 'CL-TOTE-04', price: '$84.00', stock: '16 bags in stock' },
      { name: 'Commuter Pack', sku: 'CL-PACK-22', price: '$136.00', stock: '12 bags in stock' },
    ],
  },
  technology: {
    id: 'technology', name: 'Aster Computing', category: 'Laptops and technology', domain: 'aster-computing.myshopify.com', avatar: 'A',
    orderId: 'AS-5701', customer: 'Taylor',
    products: [
      { name: 'Aster Air 14 Laptop', sku: 'AS-AIR14-16', price: '$1,199.00', stock: '8 units in stock' },
      { name: 'Aster USB-C Dock', sku: 'AS-DOCK-02', price: '$159.00', stock: '14 units in stock' },
      { name: 'Aster 65W Travel Charger', sku: 'AS-CHG-65', price: '$49.00', stock: '31 units in stock' },
    ],
  },
  belts: {
    id: 'belts', name: 'Form & Hide', category: 'Belts and leather goods', domain: 'formandhide.myshopify.com', avatar: 'F',
    orderId: 'FH-0914', customer: 'Taylor',
    products: [
      { name: 'Classic Leather Belt', sku: 'FH-BLT-01', price: '$68.00', stock: '27 belts in stock' },
      { name: 'Reversible Day Belt', sku: 'FH-RVB-02', price: '$82.00', stock: '15 belts in stock' },
      { name: 'Canvas Utility Belt', sku: 'FH-CNV-09', price: '$42.00', stock: '34 belts in stock' },
    ],
  },
});

const storeMatchers = [
  ['belts', /\b(belt|belts|leather goods)\b/i],
  ['bags', /\b(laptop bag|laptop bags|briefcase|backpack|backpacks|tech tote|carry goods|bags?)\b/i],
  ['technology', /\b(laptop|laptops|computer|computers|electronics|technology|tech brand)\b/i],
  ['footwear', /\b(shoe|shoes|sneaker|sneakers|footwear|boots|trainers)\b/i],
  ['clothing', /\b(clothing|apparel|fashion|shirt|shirts|tee|t-shirt|dress|jacket|garment)\b/i],
];

export function inferDemoStoreType(turns = []) {
  const text = (Array.isArray(turns) ? turns : [])
    .filter(turn => turn?.role === 'user')
    .map(turn => String(turn.en_text || turn.content || ''))
    .join(' ');
  return storeMatchers.find(([, matcher]) => matcher.test(text))?.[0] || 'clothing';
}
