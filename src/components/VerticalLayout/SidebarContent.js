import PropTypes from "prop-types"
import React, { useEffect, useRef , useCallback} from "react"

// //Import Scrollbar
import SimpleBar from "simplebar-react"

// MetisMenu
import MetisMenu from "metismenujs"
import { withRouter } from "react-router-dom"
import { Link } from "react-router-dom"

//i18n
import { withTranslation } from "react-i18next"

const SidebarContent = props => {
  const ref = useRef()
  const activateParentDropdown = useCallback((item) => {
    item.classList.add("active")
    const parent = item.parentElement
    const parent2El = parent.childNodes[1]
    if (parent2El && parent2El.id !== "side-menu") {
      parent2El.classList.add("mm-show")
    }
    if (parent) {
      parent.classList.add("mm-active")
      const parent2 = parent.parentElement
      if (parent2) {
        parent2.classList.add("mm-show") // ul tag
        const parent3 = parent2.parentElement // li tag
        if (parent3) {
          parent3.classList.add("mm-active") // li
          parent3.childNodes[0].classList.add("mm-active") //a
          const parent4 = parent3.parentElement // ul
          if (parent4) {
            parent4.classList.add("mm-show") // ul
            const parent5 = parent4.parentElement
            if (parent5) {
              parent5.classList.add("mm-show") // li
              parent5.childNodes[0].classList.add("mm-active") // a tag
            }
          }
        }
      }
      scrollElement(item);
      return false
    }
    scrollElement(item);
    return false
  }, []);
  // Use ComponentDidMount and ComponentDidUpdate method symultaniously
  useEffect(() => {
    const pathName = props.location.pathname
    const initMenu = () => {
      new MetisMenu("#side-menu")
      let matchingMenuItem = null
      const ul = document.getElementById("side-menu")
      const items = ul.getElementsByTagName("a")
      for (let i = 0; i < items.length; ++i) {
        if (pathName === items[i].pathname) {
          matchingMenuItem = items[i]
          break
        }
      }
      if (matchingMenuItem) {
        activateParentDropdown(matchingMenuItem)
      }
    }
    initMenu()
  }, [props.location.pathname, activateParentDropdown])
  useEffect(() => {
    ref.current.recalculate()
  }, []);
  const scrollElement = (item) => {
    if (item) {
      const currentPosition = item.offsetTop
      if (currentPosition > window.innerHeight) {
        ref.current.getScrollElement().scrollTop = currentPosition - 300
      }
    }
  }



  return (
    <React.Fragment>
      <SimpleBar ref={ref} className="vertical-simplebar">
        <div id="sidebar-menu">
          <ul className="metismenu list-unstyled" id="side-menu">
            <li>
              <Link to="/workflows" className="waves-effect">
                <i className="mdi mdi-sitemap"></i>
                <span>{props.t("Workflows")}</span>
              </Link>
            </li>

            <li>
              <Link to="/agents" className="waves-effect">
                <i className="mdi mdi-robot"></i>
                <span>{props.t("Agents")}</span>
              </Link>
            </li>

            <li>
              <Link to="/crons" className="waves-effect">
                <i className="mdi mdi-clock-outline"></i>
                <span>{props.t("Crons")}</span>
              </Link>
            </li>

            <li>
              <Link to="/logs" className="waves-effect">
                <i className="mdi mdi-file-document-outline"></i>
                <span>{props.t("Logs")}</span>
              </Link>
            </li>

            <li>
              <Link to="/health" className="waves-effect">
                <i className="mdi mdi-heart-pulse"></i>
                <span>{props.t("Health")}</span>
              </Link>
            </li>

            <li>
              <Link to="/subscription" className="waves-effect">
                <i className="mdi mdi-bell-outline"></i>
                <span>{props.t("Subscription")}</span>
              </Link>
            </li>

            <li>
              <Link to="/mcp-config" className="waves-effect">
                <i className="mdi mdi-server-network"></i>
                <span>{props.t("MCP Config")}</span>
              </Link>
            </li>

            <li>
              <Link to="/settings" className="waves-effect">
                <i className="mdi mdi-cog-outline"></i>
                <span>{props.t("Settings")}</span>
              </Link>
            </li>
          </ul>
        </div>
      </SimpleBar>
    </React.Fragment>
  )
}

SidebarContent.propTypes = {
  location: PropTypes.object,
  t: PropTypes.any,
}

export default withRouter(withTranslation()(SidebarContent))
