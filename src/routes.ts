import { Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import { literal, slash, string } from 'foldkit/route'
import { AppRoute } from './model.ts'

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))
export const documentRouter = pipe(
  literal('d'),
  slash(string('documentId')),
  Route.mapTo(AppRoute.Document),
)
export const loginRouter = pipe(
  literal('login'),
  Route.query(
    Schema.Struct({ token: Schema.OptionFromOptional(Schema.String) }),
  ),
  Route.mapTo(AppRoute.Login),
)
export const urlToAppRoute = Route.parseUrlWithFallback(
  Route.oneOf(documentRouter, loginRouter, homeRouter),
  AppRoute.NotFound,
)
export const documentUrl = (documentId: string) =>
  documentRouter({ documentId })
