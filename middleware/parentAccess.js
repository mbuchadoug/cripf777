export function canActAsParent(req, res, next) {
  if (!req.user) {
    return res.status(401).send("Not logged in");
  }

  // Anyone can be a parent
  // Parents, admins, employees are allowed
  if (["parent", "admin", "employee"].includes(req.user.role)) {
    return next();
  }

  return res.status(403).send("Parent access denied");
}
