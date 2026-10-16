// brand.js - productnaam, versie en vermeldingen. Pas hier aan om de app te herbenoemen.
(function (root) {
  'use strict';
  const brand = {
    name: 'Trekker-GPS',
    version: '0.2.0',
    company: '',  // naam van jullie bedrijf, verschijnt bij "Over"
    credits: 'Ontwikkeld met hulp van Claude, een AI-assistent van Anthropic.',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = brand;
  else root.TG = Object.assign(root.TG || {}, { brand });
})(this);
