// middleware/supplierAdminAuth.js
export function requireSupplierAdmin(req, res, next) {
  if (req.session?.isSupplierAdmin) return next();
  res.redirect("/zq-admin/login");
}