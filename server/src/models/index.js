// models/index.js — central export for all models

module.exports = {
  User: require("./User"),
  Tenant: require("./Tenant"),
  Attachment: require("./Attachment"),
  Category: require("./Category"),
  Customer: require("./Customer"),
  Location: require("./Location"),
  Product: require("./Product"),
  ProductVariant: require("./ProductVariant"),
  Inventory: require("./Inventory"),
  InventoryHistory: require("./InventoryHistory"),
  InventorySettings: require("./InventorySettings"),
  EbayProcessedOrder: require("./EbayProcessedOrder"),
  MarketplaceListing: require("./MarketplaceListing"),
  ChannelConnection: require("./ChannelConnection"),
  ChannelSyncLog: require("./ChannelSyncLog"),
  VehicleModel: require("./VehicleModel"),
};
