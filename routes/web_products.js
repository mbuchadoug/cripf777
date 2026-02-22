import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Product from "../models/product.js";

const router = express.Router();

router.use(requireWebAuth);

/**
 * GET /web/products
 * List all products
 */
router.get("/products", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { page = 1, search } = req.query;
    
    // Build query
    const query = { businessId, isActive: true };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }
    
    // Pagination
    const limit = 50;
    const skip = (page - 1) * limit;
    
    const [products, total] = await Promise.all([
      Product.find(query)
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(query)
    ]);
    
    const totalPages = Math.ceil(total / limit);
    
    res.render("web/products/list", {
      layout: "web",
      title: "Products - ZimQuote",
      user: req.webUser,
      products,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      search
    });
    
  } catch (error) {
    console.error("Products list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load products",
      user: req.webUser
    });
  }
});

/**
 * POST /web/products/create
 * Create new product
 */
router.post("/products/create", async (req, res) => {
  try {
    const { businessId, branchId } = req.webUser;
    const { name, description, unitPrice } = req.body;
    
    if (!name || !unitPrice) {
      return res.status(400).json({ error: "Name and price required" });
    }
    
    const product = await Product.create({
      businessId,
      branchId: branchId || null,
      name,
      description: description || "",
      unitPrice: parseFloat(unitPrice),
      isActive: true
    });
    
    res.json({ success: true, product });
    
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ error: "Failed to create product" });
  }
});

/**
 * PUT /web/products/:id
 * Update product
 */
router.put("/products/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { name, description, unitPrice } = req.body;
    
    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    const product = await Product.findOneAndUpdate(
      query,
      {
        name,
        description: description || "",
        unitPrice: parseFloat(unitPrice)
      },
      { new: true }
    );
    
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    
    res.json({ success: true, product });
    
  } catch (error) {
    console.error("Update product error:", error);
    res.status(500).json({ error: "Failed to update product" });
  }
});

/**
 * DELETE /web/products/:id
 * Delete product (soft delete)
 */
router.delete("/products/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    const product = await Product.findOneAndUpdate(
      query,
      { isActive: false },
      { new: true }
    );
    
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error("Delete product error:", error);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

export default router;