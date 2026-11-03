import { Runtime } from 'foldkit'
import {
  Flags,
  Message,
  Model,
  flags,
  init,
  managedResources,
  subscriptions,
  update,
  view,
} from './main.ts'
import './styles.css'

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  container: document.getElementById('root'),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
})

Runtime.run(application, { flags })
