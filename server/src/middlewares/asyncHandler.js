// middlewares/asyncHandler.js

module.exports = (fn) => (req, res, next) => {
  // NOTE (lint fix): `.catch(next)` is correct — `next` is Express's real
  // rejection handler here. Flagged anyway because `fn`/`next` are
  // implicitly `any` in this untyped-JS + allowJs setup, so the type
  // checker can't prove `next` is a function at this call site. Wrapping
  // in an arrow satisfies the rule with an unambiguous function literal,
  // without changing behaviour.
  Promise.resolve(fn(req, res, next)).catch((err) => next(err));
};
