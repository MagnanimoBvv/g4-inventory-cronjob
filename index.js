require('dotenv').config();
const axios = require('axios');
const xml2js = require('xml2js');
const { getLocationId, paginateProductsByVendor, updateInventory } = require('./shopifyFunctions');

async function getG4Products() {
    const soapBody = `<?xml version="1.0" encoding="ISO-8859-1"?>
    <SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    xmlns:urn="urn:getProductwsdl"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
        <SOAP-ENV:Body>
            <urn:getProduct>
                <user xsi:type="xsd:string">${process.env.G4_USER}</user>
                <key xsi:type="xsd:string">${process.env.G4_KEY}</key>
            </urn:getProduct>
        </SOAP-ENV:Body>
    </SOAP-ENV:Envelope>`;

    const response = await axios.post(
        'https://distr.ws.g4mexico.com/index.php',
        soapBody,
        {
            headers: {
                'Content-Type': 'text/xml; charset=ISO-8859-1',
                'SOAPAction': '"urn:getProductwsdl#getProduct"',
            },
        }
    );

    const soapParsed = await xml2js.parseStringPromise(response.data, {
        explicitArray: false,
    });
    const base64 = soapParsed['SOAP-ENV:Envelope']['SOAP-ENV:Body']['ns1:getProductResponse'].return._;
    const decodedXml = Buffer.from(base64, 'base64').toString('utf8');
    const parsed = await xml2js.parseStringPromise(decodedXml, {
        explicitArray: false,
        mergeAttrs: true,
    });

    return parsed.response;
}

async function getG4Inventory() {
    const soapBody = `<?xml version="1.0" encoding="ISO-8859-1"?>
    <SOAP-ENV:Envelope
    xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    xmlns:urn="urn:getProductStockwsdl"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
        <SOAP-ENV:Body>
            <urn:getProductStock>
                <user xsi:type="xsd:string">${process.env.G4_USER}</user>
                <key xsi:type="xsd:string">${process.env.G4_KEY}</key>
            </urn:getProductStock>
        </SOAP-ENV:Body>
    </SOAP-ENV:Envelope>`;

    const response = await axios.post(
        'https://distr.ws.g4mexico.com/index.php',
        soapBody,
        {
            headers: {
                'Content-Type': 'text/xml; charset=ISO-8859-1',
                'SOAPAction': '"urn:getProductStockwsdl#getProductStock"',
            },
        }
    );

    const soapParsed = await xml2js.parseStringPromise(response.data, {
        explicitArray: false,
    });
    const base64 = soapParsed['SOAP-ENV:Envelope']['SOAP-ENV:Body']['ns1:getProductStockResponse'].return._;
    const decodedXml = Buffer.from(base64, 'base64').toString('utf8');
    const parsed = await xml2js.parseStringPromise(decodedXml, {
        explicitArray: false,
        mergeAttrs: true,
    });


    return parsed.response.producto;
}

function getStores() {
    const storeNames = process.env.STORES.split(',');

    return storeNames.map(name => ({
        name,
        graphqlUrl: process.env[`GRAPHQL_URL_${name}`],
        shopifyToken: process.env[`SHOPIFY_TOKEN_${name}`],
    }));
}

function getActiveVariants(variants) {
    const activeVariants = [];
    for (const variant of variants) {
        const escalas = Array.isArray(variant.precios?.escala) ? variant.precios?.escala : [variant.precios?.escala];
        let isActive = true;
        for (const escala of escalas) {
            if (!escala || escala.rango === '0') {
                isActive = false;
                break;
            }
        }
        if (isActive) activeVariants.push(variant);
    }
    return activeVariants;
}

async function updateProducts(store, products, inventory) {
    const locationId = await getLocationId(store);
    const shopifyProducts = await paginateProductsByVendor(store, 'G4');
    const uniqueModels = [...new Set(products.producto.map(p => p.model))];
    for (const model of uniqueModels) {
        // if (model !== '4f0-tra') continue; // If para pruebas con un producto específico
        const variants = products.producto.filter(p => p.model === model);
        const activeVariants = getActiveVariants(variants);
        if (activeVariants.length === 0) continue;
        const product = activeVariants[0];
        try {
            const handle = `g4-${product.model}`.trim().toLowerCase();
            const shopifyProduct = shopifyProducts.find(p => p.handle === handle);
            if (!shopifyProduct) continue;

            const shopifyVariants = shopifyProduct.variants.nodes;
            const activeVariantBySKU = new Map(activeVariants.map(v => [v.codigo_producto, v]));

            for (const variant of shopifyVariants) {
                const activeVariant = activeVariantBySKU.get(variant.sku);
                const targetInventory = activeVariant ? parseInt(inventory.find(p => p.codigo_producto === activeVariant.codigo_producto).existencias, 10) : 0;
                const label = activeVariant ? 'Variante existente' : 'Variante faltante';
                console.log(`[${store.name}] ${label}: ${shopifyProduct.title} ${variant.title}, Prev ${variant.inventoryQuantity} Now ${targetInventory}`);

                if (variant.inventoryQuantity === targetInventory) continue;

                const variantToUpdate = {
                    quantities: {
                        changeFromQuantity: null,
                        inventoryItemId: variant.inventoryItem.id,
                        locationId,
                        quantity: targetInventory,
                    },
                    name: "available",
                    reason: "correction",
                };
                const response = await updateInventory(store, variantToUpdate);
                console.log(`[${store.name}] Inventario actualizado:`, response.changes);
            }
            // break;
        } catch (error) {
            console.error(`[${store.name}] Error actualizando ${product.nombre_producto} ${product.model}:`, error);
        }
    }
}

async function main() {
    const products = await getG4Products();
    const inventory = await getG4Inventory();
    if (products.status !== '1') return;

    const stores = getStores();
    for (const store of stores) {
        await updateProducts(store, products, inventory);
    }
}

main();
