// services/supplierProductTemplates.js
// ─── Admin-managed preset product/service templates per category ──────────────
//
// Structure:
//   products[]  - array of product/service names
//   prices[]    - optional suggested prices { product, amount, unit }
//   subcatMap   - optional grouping of products by sub-category (for display)
//   isAdminPreset - true means admin loaded this via the admin portal
//   adminNote   - freeform note for admin reference
//
// HOW IT WORKS:
//   1. Admin visits /zq-admin → Presets → selects a category
//   2. Admin can load/edit products and mark prices
//   3. When supplier registers in that category, they see "Use Preset List"
//   4. Supplier previews the full list, then either uses it or types their own
//
// getTemplateForCategory(catId) - returns template or null if none

const TEMPLATES = {

  // ─────────────────────────────────────────────────────────────────────────
  // PRODUCT PRESETS
  // ─────────────────────────────────────────────────────────────────────────

  building_materials: {
    isAdminPreset: true,
    adminNote: "Zimbabwe market building materials - prices USD Jan 2025",
    products: [
      // Cement & Lime
      "Portland cement 50kg",
      "PPC cement 50kg",
      "Lime 25kg",
      // Sand & Aggregates
      "River sand (per load)",
      "Pit sand (per load)",
      "Crusher run (per load)",
      "Quarry stone 19mm (per load)",
      "Quarry stone 13mm (per load)",
      "Sharp sand (per bag)",
      // Bricks & Blocks
      "Face brick (each)",
      "Common brick (each)",
      "Hollow block 140mm (each)",
      "Hollow block 190mm (each)",
      "Paving brick (each)",
      // Roofing
      "Corrugated iron sheet 3m",
      "Corrugated iron sheet 2.4m",
      "IBR roofing sheet 3m",
      "IBR roofing sheet 2.4m",
      "Roof nail (per kg)",
      "Ridgecap (each)",
      // Steel & Iron
      "Steel bar Y10 (per 12m)",
      "Steel bar Y12 (per 12m)",
      "Steel bar Y16 (per 12m)",
      "BRC mesh A142 (per sheet)",
      "Angle iron 25x25mm (per 6m)",
      "Angle iron 50x50mm (per 6m)",
      "Square tube 25x25mm (per 6m)",
      "Flat bar 25x3mm (per 6m)",
      // Timber
      "Timber 50x50mm (per 4.8m)",
      "Timber 50x76mm (per 4.8m)",
      "Timber 50x100mm (per 4.8m)",
      "Timber 50x152mm (per 4.8m)",
      "Plywood 18mm (per sheet)",
      "Plywood 12mm (per sheet)",
      "Chipboard 18mm (per sheet)",
      "Hardboard (per sheet)",
      // Paints
      "PVA paint white 20L",
      "PVA paint white 5L",
      "Dulux exterior 20L",
      "Dulux interior 20L",
      "Cement paint 25kg",
      "Texture coat 25kg",
      "Putty 5kg",
      "Undercoat 5L",
      // Adhesives & Waterproofing
      "Tile adhesive 25kg",
      "Tile adhesive flexible 25kg",
      "Grout white 5kg",
      "Grout grey 5kg",
      "Waterproof additive 5L",
      "Bond aid 5L",
      "Bitumen paint 5L"
    ],
    prices: [
      { product: "Portland cement 50kg",          amount: 12.50, unit: "bag"   },
      { product: "PPC cement 50kg",               amount: 13.00, unit: "bag"   },
      { product: "Lime 25kg",                     amount: 6.50,  unit: "bag"   },
      { product: "River sand (per load)",         amount: 80.00, unit: "load"  },
      { product: "Pit sand (per load)",           amount: 65.00, unit: "load"  },
      { product: "Crusher run (per load)",        amount: 90.00, unit: "load"  },
      { product: "Quarry stone 19mm (per load)",  amount: 95.00, unit: "load"  },
      { product: "Quarry stone 13mm (per load)",  amount: 95.00, unit: "load"  },
      { product: "Sharp sand (per bag)",          amount: 2.00,  unit: "bag"   },
      { product: "Face brick (each)",             amount: 0.15,  unit: "each"  },
      { product: "Common brick (each)",           amount: 0.12,  unit: "each"  },
      { product: "Hollow block 140mm (each)",     amount: 0.90,  unit: "each"  },
      { product: "Hollow block 190mm (each)",     amount: 1.10,  unit: "each"  },
      { product: "Paving brick (each)",           amount: 0.25,  unit: "each"  },
      { product: "Corrugated iron sheet 3m",      amount: 9.50,  unit: "sheet" },
      { product: "Corrugated iron sheet 2.4m",    amount: 7.50,  unit: "sheet" },
      { product: "IBR roofing sheet 3m",          amount: 11.00, unit: "sheet" },
      { product: "IBR roofing sheet 2.4m",        amount: 8.50,  unit: "sheet" },
      { product: "Roof nail (per kg)",            amount: 2.50,  unit: "kg"    },
      { product: "Ridgecap (each)",               amount: 3.50,  unit: "each"  },
      { product: "Steel bar Y10 (per 12m)",       amount: 12.00, unit: "bar"   },
      { product: "Steel bar Y12 (per 12m)",       amount: 16.00, unit: "bar"   },
      { product: "Steel bar Y16 (per 12m)",       amount: 22.00, unit: "bar"   },
      { product: "BRC mesh A142 (per sheet)",     amount: 45.00, unit: "sheet" },
      { product: "Angle iron 25x25mm (per 6m)",   amount: 6.00,  unit: "each"  },
      { product: "Angle iron 50x50mm (per 6m)",   amount: 14.00, unit: "each"  },
      { product: "Plywood 18mm (per sheet)",      amount: 28.00, unit: "sheet" },
      { product: "Plywood 12mm (per sheet)",      amount: 20.00, unit: "sheet" },
      { product: "Chipboard 18mm (per sheet)",    amount: 18.00, unit: "sheet" },
      { product: "PVA paint white 20L",           amount: 35.00, unit: "bucket"},
      { product: "PVA paint white 5L",            amount: 10.00, unit: "tin"   },
      { product: "Dulux exterior 20L",            amount: 55.00, unit: "bucket"},
      { product: "Dulux interior 20L",            amount: 50.00, unit: "bucket"},
      { product: "Cement paint 25kg",             amount: 15.00, unit: "bag"   },
      { product: "Texture coat 25kg",             amount: 18.00, unit: "bag"   },
      { product: "Tile adhesive 25kg",            amount: 12.00, unit: "bag"   },
      { product: "Grout white 5kg",               amount: 5.00,  unit: "bag"   },
      { product: "Waterproof additive 5L",        amount: 8.50,  unit: "each"  },
      { product: "Bond aid 5L",                   amount: 7.00,  unit: "each"  }
    ],
    subcatMap: {
      "Cement & Lime":            ["Portland cement 50kg", "PPC cement 50kg", "Lime 25kg"],
      "Sand & Aggregates":        ["River sand (per load)", "Pit sand (per load)", "Crusher run (per load)", "Quarry stone 19mm (per load)", "Quarry stone 13mm (per load)", "Sharp sand (per bag)"],
      "Bricks & Blocks":          ["Face brick (each)", "Common brick (each)", "Hollow block 140mm (each)", "Hollow block 190mm (each)", "Paving brick (each)"],
      "Roofing Sheets":           ["Corrugated iron sheet 3m", "Corrugated iron sheet 2.4m", "IBR roofing sheet 3m", "IBR roofing sheet 2.4m", "Roof nail (per kg)", "Ridgecap (each)"],
      "Steel & Iron":             ["Steel bar Y10 (per 12m)", "Steel bar Y12 (per 12m)", "Steel bar Y16 (per 12m)", "BRC mesh A142 (per sheet)", "Angle iron 25x25mm (per 6m)", "Angle iron 50x50mm (per 6m)", "Square tube 25x25mm (per 6m)", "Flat bar 25x3mm (per 6m)"],
      "Timber & Wood":            ["Timber 50x50mm (per 4.8m)", "Timber 50x76mm (per 4.8m)", "Timber 50x100mm (per 4.8m)", "Timber 50x152mm (per 4.8m)", "Plywood 18mm (per sheet)", "Plywood 12mm (per sheet)", "Chipboard 18mm (per sheet)", "Hardboard (per sheet)"],
      "Paints & Finishes":        ["PVA paint white 20L", "PVA paint white 5L", "Dulux exterior 20L", "Dulux interior 20L", "Cement paint 25kg", "Texture coat 25kg", "Putty 5kg", "Undercoat 5L"],
      "Adhesives & Waterproofing": ["Tile adhesive 25kg", "Tile adhesive flexible 25kg", "Grout white 5kg", "Grout grey 5kg", "Waterproof additive 5L", "Bond aid 5L", "Bitumen paint 5L"]
    }
  },

  hardware_tools: {
    isAdminPreset: true,
    adminNote: "General hardware tools - Zimbabwe market",
    products: [
      "Hammer 500g", "Hammer 1kg", "Claw hammer",
      "Nails 2 inch (per kg)", "Nails 3 inch (per kg)", "Nails 4 inch (per kg)",
      "Screws 1 inch (box 200)", "Screws 2 inch (box 200)", "Screws 3 inch (box 100)",
      "Rawl bolt M6 (box)", "Rawl bolt M8 (box)", "Rawl bolt M10 (box)",
      "Padlock 40mm", "Padlock 50mm", "Padlock 70mm", "Padlock 90mm",
      "Door lock set (lever)", "Mortice lock set", "Door handle set (pair)",
      "Hinge 75mm (pair)", "Hinge 100mm (pair)", "Hinge 125mm (pair)",
      "Drill bit set (wood)", "Drill bit set (masonry)", "Drill bit set (metal)",
      "Spanner set 6pc", "Spanner set 12pc", "Socket set 1/2 inch",
      "Pliers set", "Combination pliers", "Wire cutters",
      "Screwdriver set flat", "Screwdriver set Phillips", "Multi-bit screwdriver",
      "Tape measure 5m", "Tape measure 7.5m",
      "Spirit level 600mm", "Spirit level 1.2m",
      "Angle grinder 115mm", "Angle grinder 125mm",
      "Cutting disc 115mm (box 25)", "Grinding disc 115mm (box 10)",
      "Extension cord 10m", "Extension cord 20m",
      "Wheelbarrow contractor", "Building trowel", "Pointing trowel",
      "Plastering float wood", "Plastering float plastic",
      "Wire (per roll)", "Binding wire (per kg)",
      "Safety boots size 8", "Safety boots size 9", "Safety boots size 10", "Safety boots size 11",
      "Safety gloves", "Safety helmet", "Safety goggles", "Dust mask (box 20)",
      "Sandpaper 80 grit (per sheet)", "Sandpaper 120 grit (per sheet)",
      "Masking tape 25mm", "Duct tape", "PVC insulation tape",
      "Silicon sealant clear", "Silicon sealant white", "Silicon gun"
    ],
    prices: [
      { product: "Nails 2 inch (per kg)",       amount: 2.50,  unit: "kg"   },
      { product: "Nails 3 inch (per kg)",        amount: 2.50,  unit: "kg"   },
      { product: "Nails 4 inch (per kg)",        amount: 2.50,  unit: "kg"   },
      { product: "Padlock 40mm",                 amount: 4.00,  unit: "each" },
      { product: "Padlock 50mm",                 amount: 6.00,  unit: "each" },
      { product: "Padlock 70mm",                 amount: 9.00,  unit: "each" },
      { product: "Padlock 90mm",                 amount: 14.00, unit: "each" },
      { product: "Extension cord 10m",           amount: 15.00, unit: "each" },
      { product: "Extension cord 20m",           amount: 25.00, unit: "each" },
      { product: "Cutting disc 115mm (box 25)",  amount: 18.00, unit: "box"  },
      { product: "Silicon sealant clear",        amount: 3.50,  unit: "each" },
      { product: "Silicon sealant white",        amount: 3.50,  unit: "each" }
    ]
  },

  plumbing_supplies: {
    isAdminPreset: true,
    adminNote: "Full plumbing supplies - Zimbabwe market USD prices",
    products: [
      // PVC Pressure Pipes (SABS)
      "PVC pipe class 6 15mm (per 6m)",
      "PVC pipe class 6 20mm (per 6m)",
      "PVC pipe class 6 25mm (per 6m)",
      "PVC pipe class 6 32mm (per 6m)",
      "PVC pipe class 6 40mm (per 6m)",
      "PVC pipe class 6 50mm (per 6m)",
      "PVC pipe class 6 63mm (per 6m)",
      "PVC pipe class 9 15mm (per 6m)",
      "PVC pipe class 9 20mm (per 6m)",
      "PVC pipe class 9 25mm (per 6m)",
      // PVC Drainage Pipes
      "PVC drain pipe 40mm (per 6m)",
      "PVC drain pipe 50mm (per 6m)",
      "PVC drain pipe 110mm (per 6m)",
      "PVC drain pipe 160mm (per 6m)",
      // Copper Pipes
      "Copper pipe 15mm (per 6m)",
      "Copper pipe 22mm (per 6m)",
      "Copper pipe 28mm (per 6m)",
      // CPVC Hot Water Pipes
      "CPVC pipe 15mm (per 6m)",
      "CPVC pipe 20mm (per 6m)",
      "CPVC pipe 25mm (per 6m)",
      // PVC Pressure Fittings
      "PVC elbow 15mm",
      "PVC elbow 20mm",
      "PVC elbow 25mm",
      "PVC elbow 32mm",
      "PVC tee 15mm",
      "PVC tee 20mm",
      "PVC tee 25mm",
      "PVC tee 32mm",
      "PVC coupler 15mm",
      "PVC coupler 20mm",
      "PVC coupler 25mm",
      "PVC reducer 20x15mm",
      "PVC reducer 25x20mm",
      "PVC reducer 32x25mm",
      "PVC male thread 15mm",
      "PVC female thread 15mm",
      "PVC end cap 15mm",
      "PVC end cap 20mm",
      // Copper Fittings
      "Copper elbow 15mm",
      "Copper tee 15mm",
      "Copper coupler 15mm",
      "Copper male iron 15mm",
      "Copper female iron 15mm",
      // Valves
      "Gate valve brass 15mm",
      "Gate valve brass 20mm",
      "Gate valve brass 25mm",
      "Gate valve brass 32mm",
      "Ball valve brass 15mm",
      "Ball valve brass 20mm",
      "Ball valve brass 25mm",
      "Ball valve brass 32mm",
      "Check valve brass 15mm",
      "Check valve brass 20mm",
      "Float valve 15mm plastic",
      "Float valve 20mm plastic",
      "Float valve 15mm brass",
      "PRV (pressure reducing valve) 15mm",
      "PRV (pressure reducing valve) 20mm",
      // Taps & Showers
      "Basin tap chrome (pair)",
      "Bath tap chrome (pair)",
      "Kitchen sink tap pillar",
      "Kitchen sink tap mixer",
      "Shower mixer exposed chrome",
      "Shower mixer concealed chrome",
      "Shower head standard",
      "Shower head rain 200mm",
      "Outdoor bib tap 15mm",
      "Hose tap 15mm",
      "Outside tap lock",
      // Bathroom Suites
      "Toilet suite close-coupled (white)",
      "Toilet pan wall-hung",
      "Toilet cistern only",
      "Toilet seat and cover",
      "Washbasin 500mm wall-hung",
      "Washbasin 600mm pedestal",
      "Bathtub 1500mm acrylic",
      "Bathtub 1700mm acrylic",
      "Shower tray 900x900",
      "Shower enclosure 900x900",
      // Water Tanks
      "Water tank 1000L (Jumbo black)",
      "Water tank 2000L (Jumbo black)",
      "Water tank 5000L (Jumbo black)",
      "Water tank 500L (JoJo)",
      // Geysers
      "Electric geyser 50L",
      "Electric geyser 100L",
      "Electric geyser 150L",
      "Electric geyser 200L",
      "Solar geyser 100L flat plate",
      "Solar geyser 200L flat plate",
      "Geyser element 3kW",
      "Geyser thermostat",
      "Geyser pressure valve",
      // Drainage Fittings
      "P-trap 32mm",
      "P-trap 40mm",
      "P-trap 50mm",
      "Bottle trap 32mm",
      "Floor drain 100mm chrome",
      "Floor drain 100mm plastic",
      "Inspection eye 100mm",
      "Y-junction 50mm",
      "Y-junction 110mm",
      "Bend 87.5deg 110mm",
      "Boss connector 110mm",
      // Accessories
      "PTFE tape (plumber tape)",
      "Pipe clip 15mm (each)",
      "Pipe clip 20mm (each)",
      "Pipe clip 25mm (each)",
      "Pipe insulation 15mm (per m)",
      "Pipe insulation 22mm (per m)",
      "Silicon sealant white",
      "Thread sealant paste",
      "PVC solvent cement 125ml"
    ],
    prices: [
      { product: "PVC pipe class 6 15mm (per 6m)",  amount: 3.50,   unit: "each" },
      { product: "PVC pipe class 6 20mm (per 6m)",  amount: 4.50,   unit: "each" },
      { product: "PVC pipe class 6 25mm (per 6m)",  amount: 5.50,   unit: "each" },
      { product: "PVC pipe class 6 32mm (per 6m)",  amount: 7.00,   unit: "each" },
      { product: "PVC pipe class 6 40mm (per 6m)",  amount: 9.00,   unit: "each" },
      { product: "PVC pipe class 6 50mm (per 6m)",  amount: 11.00,  unit: "each" },
      { product: "PVC pipe class 6 63mm (per 6m)",  amount: 16.00,  unit: "each" },
      { product: "PVC drain pipe 40mm (per 6m)",    amount: 5.00,   unit: "each" },
      { product: "PVC drain pipe 50mm (per 6m)",    amount: 7.00,   unit: "each" },
      { product: "PVC drain pipe 110mm (per 6m)",   amount: 22.00,  unit: "each" },
      { product: "Copper pipe 15mm (per 6m)",       amount: 18.00,  unit: "each" },
      { product: "Copper pipe 22mm (per 6m)",       amount: 28.00,  unit: "each" },
      { product: "PVC elbow 15mm",                  amount: 0.30,   unit: "each" },
      { product: "PVC elbow 20mm",                  amount: 0.40,   unit: "each" },
      { product: "PVC elbow 25mm",                  amount: 0.60,   unit: "each" },
      { product: "PVC tee 15mm",                    amount: 0.40,   unit: "each" },
      { product: "PVC tee 20mm",                    amount: 0.55,   unit: "each" },
      { product: "PVC coupler 15mm",                amount: 0.25,   unit: "each" },
      { product: "PVC coupler 20mm",                amount: 0.35,   unit: "each" },
      { product: "Gate valve brass 15mm",           amount: 4.00,   unit: "each" },
      { product: "Gate valve brass 20mm",           amount: 5.50,   unit: "each" },
      { product: "Gate valve brass 25mm",           amount: 7.00,   unit: "each" },
      { product: "Ball valve brass 15mm",           amount: 3.50,   unit: "each" },
      { product: "Ball valve brass 20mm",           amount: 4.50,   unit: "each" },
      { product: "Ball valve brass 25mm",           amount: 6.00,   unit: "each" },
      { product: "Float valve 15mm plastic",        amount: 2.50,   unit: "each" },
      { product: "Float valve 15mm brass",          amount: 4.50,   unit: "each" },
      { product: "Basin tap chrome (pair)",         amount: 12.00,  unit: "pair" },
      { product: "Bath tap chrome (pair)",          amount: 15.00,  unit: "pair" },
      { product: "Shower mixer exposed chrome",     amount: 35.00,  unit: "each" },
      { product: "Toilet suite close-coupled (white)", amount: 95.00, unit: "each" },
      { product: "Washbasin 500mm wall-hung",       amount: 45.00,  unit: "each" },
      { product: "Water tank 1000L (Jumbo black)",  amount: 180.00, unit: "each" },
      { product: "Water tank 2000L (Jumbo black)",  amount: 320.00, unit: "each" },
      { product: "Water tank 5000L (Jumbo black)",  amount: 750.00, unit: "each" },
      { product: "Electric geyser 50L",             amount: 180.00, unit: "each" },
      { product: "Electric geyser 100L",            amount: 280.00, unit: "each" },
      { product: "Electric geyser 150L",            amount: 380.00, unit: "each" },
      { product: "Electric geyser 200L",            amount: 480.00, unit: "each" },
      { product: "Geyser element 3kW",              amount: 18.00,  unit: "each" },
      { product: "PTFE tape (plumber tape)",        amount: 0.50,   unit: "each" },
      { product: "PVC solvent cement 125ml",        amount: 2.50,   unit: "each" }
    ],
    subcatMap: {
      "PVC Pressure Pipes":     ["PVC pipe class 6 15mm (per 6m)", "PVC pipe class 6 20mm (per 6m)", "PVC pipe class 6 25mm (per 6m)", "PVC pipe class 6 32mm (per 6m)", "PVC pipe class 6 40mm (per 6m)", "PVC pipe class 6 50mm (per 6m)", "PVC pipe class 6 63mm (per 6m)"],
      "PVC Drainage Pipes":     ["PVC drain pipe 40mm (per 6m)", "PVC drain pipe 50mm (per 6m)", "PVC drain pipe 110mm (per 6m)", "PVC drain pipe 160mm (per 6m)"],
      "Copper Pipes":           ["Copper pipe 15mm (per 6m)", "Copper pipe 22mm (per 6m)", "Copper pipe 28mm (per 6m)"],
      "PVC Fittings":           ["PVC elbow 15mm", "PVC elbow 20mm", "PVC elbow 25mm", "PVC tee 15mm", "PVC tee 20mm", "PVC coupler 15mm", "PVC coupler 20mm", "PVC reducer 20x15mm"],
      "Valves":                 ["Gate valve brass 15mm", "Gate valve brass 20mm", "Gate valve brass 25mm", "Ball valve brass 15mm", "Ball valve brass 20mm", "Ball valve brass 25mm", "Float valve 15mm plastic", "Float valve 15mm brass"],
      "Taps & Showers":         ["Basin tap chrome (pair)", "Bath tap chrome (pair)", "Kitchen sink tap pillar", "Shower mixer exposed chrome", "Shower head standard", "Outdoor bib tap 15mm"],
      "Bathroom Suites":        ["Toilet suite close-coupled (white)", "Toilet pan wall-hung", "Washbasin 500mm wall-hung", "Washbasin 600mm pedestal", "Bathtub 1500mm acrylic"],
      "Water Tanks":            ["Water tank 500L (JoJo)", "Water tank 1000L (Jumbo black)", "Water tank 2000L (Jumbo black)", "Water tank 5000L (Jumbo black)"],
      "Geysers":                ["Electric geyser 50L", "Electric geyser 100L", "Electric geyser 150L", "Electric geyser 200L", "Solar geyser 100L flat plate", "Solar geyser 200L flat plate", "Geyser element 3kW"],
      "Drainage Fittings":      ["P-trap 32mm", "P-trap 40mm", "Bottle trap 32mm", "Floor drain 100mm chrome", "Y-junction 110mm"]
    }
  },

  electrical_supplies: {
    isAdminPreset: true,
    adminNote: "Electrical materials for Zimbabwe market",
    products: [
      "Electrical cable 1.5mm (per 100m)", "Electrical cable 2.5mm (per 100m)",
      "Electrical cable 4mm (per 100m)", "Electrical cable 6mm (per 100m)",
      "Earth cable green/yellow 2.5mm (per 100m)",
      "DB board 4-way surface", "DB board 8-way surface", "DB board 12-way surface",
      "DB board 16-way flush", "DB board 20-way flush",
      "Circuit breaker 10A single pole", "Circuit breaker 16A single pole",
      "Circuit breaker 20A single pole", "Circuit breaker 32A single pole",
      "Circuit breaker 40A double pole", "Earth leakage 25A/30mA",
      "Single plug socket", "Double plug socket", "Single light switch",
      "Double light switch", "Intermediate switch",
      "LED bulb 9W E27", "LED bulb 15W E27", "LED bulb 9W B22",
      "LED downlight 10W", "Fluorescent tube 36W",
      "Conduit 20mm PVC (per 3m)", "Conduit 25mm PVC (per 3m)",
      "Conduit bend 20mm", "Conduit junction box 20mm",
      "Cable trunking 40x25mm (per 2m)"
    ],
    prices: [
      { product: "Electrical cable 1.5mm (per 100m)", amount: 45.00,  unit: "roll"  },
      { product: "Electrical cable 2.5mm (per 100m)", amount: 65.00,  unit: "roll"  },
      { product: "Electrical cable 4mm (per 100m)",   amount: 95.00,  unit: "roll"  },
      { product: "DB board 4-way surface",             amount: 12.00,  unit: "each"  },
      { product: "DB board 8-way surface",             amount: 22.00,  unit: "each"  },
      { product: "DB board 12-way surface",            amount: 32.00,  unit: "each"  },
      { product: "Circuit breaker 16A single pole",    amount: 4.50,   unit: "each"  },
      { product: "Circuit breaker 32A single pole",    amount: 6.00,   unit: "each"  },
      { product: "Earth leakage 25A/30mA",             amount: 35.00,  unit: "each"  },
      { product: "Double plug socket",                 amount: 4.00,   unit: "each"  },
      { product: "LED bulb 9W E27",                    amount: 2.50,   unit: "each"  },
      { product: "LED downlight 10W",                  amount: 6.00,   unit: "each"  }
    ]
  },

  solar_energy: {
    isAdminPreset: true,
    adminNote: "Solar and energy products - Zimbabwe market",
    products: [
      "Solar panel 100W monocrystalline", "Solar panel 250W monocrystalline",
      "Solar panel 400W monocrystalline", "Solar panel 550W monocrystalline",
      "Inverter 1kVA", "Inverter 2kVA", "Inverter 3kVA", "Inverter 5kVA",
      "Hybrid inverter 3kVA", "Hybrid inverter 5kVA",
      "Charge controller 20A MPPT", "Charge controller 40A MPPT",
      "Charge controller 60A MPPT",
      "Battery 100Ah AGM", "Battery 200Ah AGM",
      "Lithium battery 100Ah 48V", "Lithium battery 200Ah 48V",
      "Solar geyser 100L flat plate", "Solar geyser 200L flat plate",
      "Solar panel mounting bracket", "Solar cable 4mm (per 50m)",
      "MC4 connector pair", "Solar combiner box",
      "UPS 1kVA", "UPS 2kVA"
    ],
    prices: [
      { product: "Solar panel 100W monocrystalline", amount: 55.00,  unit: "each" },
      { product: "Solar panel 250W monocrystalline", amount: 110.00, unit: "each" },
      { product: "Solar panel 400W monocrystalline", amount: 165.00, unit: "each" },
      { product: "Solar panel 550W monocrystalline", amount: 200.00, unit: "each" },
      { product: "Inverter 1kVA",                   amount: 120.00, unit: "each" },
      { product: "Inverter 2kVA",                   amount: 200.00, unit: "each" },
      { product: "Inverter 3kVA",                   amount: 280.00, unit: "each" },
      { product: "Hybrid inverter 5kVA",             amount: 650.00, unit: "each" },
      { product: "Battery 100Ah AGM",               amount: 130.00, unit: "each" },
      { product: "Lithium battery 100Ah 48V",       amount: 450.00, unit: "each" }
    ]
  },

  groceries: {
    isAdminPreset: false,
    products: ["cooking oil", "rice", "sugar", "flour", "bread", "mealie meal", "salt", "baked beans", "sardines", "milk"],
    prices: []
  },

  agriculture: {
    isAdminPreset: false,
    products: ["maize seed 10kg", "fertilizer AN 50kg", "fertilizer compound D 50kg", "pesticide 1L", "irrigation pipe 25mm", "water pump 1hp"],
    prices: []
  },

  car_supplies: {
    isAdminPreset: false,
    products: ["car battery 45Ah", "engine oil 5L", "brake pads (pair)", "tyres 195/65/15", "shock absorber", "air filter", "oil filter"],
    prices: []
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SERVICE PRESETS
  // ─────────────────────────────────────────────────────────────────────────

  plumbing_services: {
    isAdminPreset: true,
    adminNote: "Plumbing service rates - Zimbabwe USD",
    products: [
      "Burst pipe repair",
      "Geyser installation (supply + fit)",
      "Geyser repair (element/thermostat)",
      "Solar geyser installation",
      "Blocked drain clearing",
      "Toilet installation",
      "Toilet repair (cistern/valve)",
      "Basin installation",
      "Bath installation",
      "Shower installation",
      "Water tank installation",
      "Float valve replacement",
      "Gate valve replacement",
      "Tap replacement",
      "Pipe relaying (per metre)",
      "Borehole pump installation",
      "Borehole pump repair",
      "General plumbing call-out",
      "Leak detection",
      "Sewer line unblocking"
    ],
    prices: [
      { product: "Burst pipe repair",                     amount: 25.00,  unit: "job" },
      { product: "Geyser installation (supply + fit)",    amount: 120.00, unit: "job" },
      { product: "Geyser repair (element/thermostat)",    amount: 35.00,  unit: "job" },
      { product: "Solar geyser installation",             amount: 180.00, unit: "job" },
      { product: "Blocked drain clearing",                amount: 30.00,  unit: "job" },
      { product: "Toilet installation",                   amount: 40.00,  unit: "job" },
      { product: "Toilet repair (cistern/valve)",         amount: 20.00,  unit: "job" },
      { product: "Basin installation",                    amount: 35.00,  unit: "job" },
      { product: "Shower installation",                   amount: 80.00,  unit: "job" },
      { product: "Water tank installation",               amount: 60.00,  unit: "job" },
      { product: "Float valve replacement",               amount: 15.00,  unit: "job" },
      { product: "Tap replacement",                       amount: 20.00,  unit: "job" },
      { product: "Pipe relaying (per metre)",             amount: 8.00,   unit: "m"   },
      { product: "General plumbing call-out",             amount: 15.00,  unit: "hr"  },
      { product: "Sewer line unblocking",                 amount: 50.00,  unit: "job" }
    ]
  },

  electrical_services: {
    isAdminPreset: true,
    adminNote: "Electrical service rates - Zimbabwe USD",
    products: [
      "House wiring (new) per point",
      "DB board installation",
      "DB board upgrade",
      "Circuit breaker replacement",
      "Earth leakage installation",
      "Power point installation",
      "Light fitting installation",
      "Solar system installation (1-3kW)",
      "Solar system installation (5kW+)",
      "CCTV installation (4 cameras)",
      "CCTV installation (8 cameras)",
      "Alarm system installation",
      "Electric fence installation (per metre)",
      "Fault finding & repair",
      "Outdoor security lights installation",
      "Prepaid meter installation",
      "General electrical call-out"
    ],
    prices: [
      { product: "House wiring (new) per point",          amount: 12.00,  unit: "point" },
      { product: "DB board installation",                  amount: 80.00,  unit: "job"   },
      { product: "Circuit breaker replacement",            amount: 20.00,  unit: "job"   },
      { product: "Earth leakage installation",             amount: 45.00,  unit: "job"   },
      { product: "Power point installation",               amount: 15.00,  unit: "point" },
      { product: "Light fitting installation",             amount: 10.00,  unit: "each"  },
      { product: "Solar system installation (1-3kW)",      amount: 300.00, unit: "job"   },
      { product: "Solar system installation (5kW+)",       amount: 600.00, unit: "job"   },
      { product: "CCTV installation (4 cameras)",          amount: 250.00, unit: "job"   },
      { product: "Fault finding & repair",                 amount: 20.00,  unit: "hr"    },
      { product: "General electrical call-out",            amount: 15.00,  unit: "hr"    }
    ]
  },

  construction_services: {
    isAdminPreset: true,
    adminNote: "Construction service rates - Zimbabwe USD",
    products: [
      "Bricklaying (per 1000 bricks)",
      "Plastering (per sqm)",
      "Screeding (per sqm)",
      "Roofing - IBR sheet fixing (per sqm)",
      "Roofing - truss erection (per sqm)",
      "Floor tiling (per sqm)",
      "Wall tiling (per sqm)",
      "Foundation excavation (per m3)",
      "Concrete casting (per m3)",
      "House renovation - general",
      "Painting - interior (per room)",
      "Painting - exterior (per sqm)",
      "Guttering installation (per metre)",
      "Partition wall (per sqm)",
      "Ceiling board installation (per sqm)"
    ],
    prices: [
      { product: "Bricklaying (per 1000 bricks)",      amount: 35.00,  unit: "1000" },
      { product: "Plastering (per sqm)",               amount: 4.50,   unit: "sqm"  },
      { product: "Screeding (per sqm)",                amount: 5.00,   unit: "sqm"  },
      { product: "Roofing - IBR sheet fixing (per sqm)", amount: 6.00, unit: "sqm"  },
      { product: "Floor tiling (per sqm)",             amount: 8.00,   unit: "sqm"  },
      { product: "Wall tiling (per sqm)",              amount: 10.00,  unit: "sqm"  },
      { product: "Foundation excavation (per m3)",     amount: 15.00,  unit: "m3"   },
      { product: "Concrete casting (per m3)",          amount: 45.00,  unit: "m3"   },
      { product: "Painting - interior (per room)",     amount: 80.00,  unit: "room" },
      { product: "Painting - exterior (per sqm)",      amount: 3.50,   unit: "sqm"  }
    ]
  },

  painting_services: {
    isAdminPreset: false,
    products: ["Interior painting (per room)", "Exterior painting (per sqm)", "Roof painting", "Texture coat application (per sqm)", "Wallpaper installation (per roll)"],
    prices: []
  },

  welding_services: {
    isAdminPreset: false,
    products: ["Gate fabrication (per metre)", "Burglar bars (window)", "Security door", "Carport (single)", "Carport (double)", "Braai stand", "Steel staircase"],
    prices: []
  }
};

/**
 * Get the template for a category ID.
 * Returns null if no template exists.
 */
export function getTemplateForCategory(catId) {
  return TEMPLATES[catId] || null;
}

/**
 * Get all categories that have admin presets loaded.
 * Used by the admin portal to show preset status.
 */
export function getPresetCategories() {
  return Object.entries(TEMPLATES)
    .filter(([, t]) => t.isAdminPreset)
    .map(([id, t]) => ({
      id,
      productCount: t.products?.length || 0,
      priceCount: t.prices?.length || 0,
      hasSubcats: !!t.subcatMap
    }));
}

/**
 * Admin: update or create a preset for a category.
 * In production this writes to MongoDB (CategoryPreset model).
 * This in-memory version is the fallback / default.
 */
/**
 * Admin: update or create a preset for a category.
 * Also updates in-memory TEMPLATES so changes are live immediately.
 */
export function setTemplateForCategory(catId, template) {
  TEMPLATES[catId] = template;
}

/**
 * DB-aware async version of getTemplateForCategory.
 * Checks MongoDB CategoryPreset collection first (admin-editable presets),
 * then falls back to static TEMPLATES in this file.
 *
 * Use this in chatbotEngine.js and supplierRegistration.js
 * wherever you call getTemplateForCategory().
 */
export async function getTemplateForCategoryWithDB(catId) {
  try {
    const { default: CategoryPreset } = await import("../models/categoryPreset.js");
    const dbPreset = await CategoryPreset.findOne({ catId, isActive: true }).lean();
    if (dbPreset && dbPreset.products?.length) {
      return {
        isAdminPreset: true,
        adminNote: dbPreset.adminNote || "",
        products: dbPreset.products,
        prices: dbPreset.prices || [],
        subcatMap: dbPreset.subcatMap?.length
          ? Object.fromEntries(dbPreset.subcatMap.map(s => [s.label, s.products]))
          : null
      };
    }
  } catch (_err) {
    // DB unavailable or CategoryPreset model not found — fall through to static
  }
  // Fallback: return static template from this file
  return TEMPLATES[catId] || null;
}

export { TEMPLATES };