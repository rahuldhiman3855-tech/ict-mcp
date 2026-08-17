import PropTypes from "prop-types";
import React, { useState, useEffect } from "react";

import { connect } from "react-redux";
import {
  Container,
  Dropdown,
  DropdownToggle,
  DropdownMenu,
} from "reactstrap";

import { Link } from "react-router-dom";
import { withTranslation } from "react-i18next";

import {
  toggleLeftmenu,
  changeSidebarType,
} from "../../store/actions";

const icon = "/icon.svg";

const Header = (props) => {
  const [menu, setMenu] = useState(false);
  const [username, setUsername] = useState("Admin");

  useEffect(() => {
    const authUser = localStorage.getItem("authUser");
    if (authUser) {
      const obj = JSON.parse(authUser);
      setUsername(obj.username || obj.displayName || obj.email || "Admin");
    }
  }, []);

  function toggleFullscreen() {
    if (
      !document.fullscreenElement &&
      !document.mozFullScreenElement &&
      !document.webkitFullscreenElement
    ) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      } else if (document.documentElement.mozRequestFullScreen) {
        document.documentElement.mozRequestFullScreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen(
          Element.ALLOW_KEYBOARD_INPUT
        );
      }
    } else {
      if (document.cancelFullScreen) {
        document.cancelFullScreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.webkitCancelFullScreen) {
        document.webkitCancelFullScreen();
      }
    }
  }

  function tToggle() {
    const body = document.body;

    if (window.screen.width <= 768) {
      body.classList.toggle("sidebar-enable");
    } else {
      body.classList.toggle("vertical-collpsed");
      body.classList.toggle("sidebar-enable");
    }
  }

  return (
    <React.Fragment>
      <header id="page-topbar">
        <div className="navbar-header">
          <Container fluid>
            <div className="header-content">
              {/* Left side */}
              <div className="header-left">
                <Link to="/" className="header-logo">
                  <img
                    src={icon}
                    alt="ICT Cron Manager"
                    className="header-logo-icon"
                  />
                  <span className="mechanical-agent-text">
                    Workflow Builder
                  </span>
                </Link>

                {/* Mobile menu */}
                <button
                  type="button"
                  className="btn btn-sm px-3 font-size-16 d-lg-none header-item waves-effect waves-light"
                  onClick={tToggle}
                  data-toggle="collapse"
                  data-target="#topnav-menu-content"
                >
                  <i className="fa fa-fw fa-bars"></i>
                </button>
              </div>

              {/* Right side */}
              <div className="header-right">
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  className="btn header-item noti-icon waves-effect"
                  data-toggle="fullscreen"
                  title="Toggle fullscreen"
                >
                  <i className="mdi mdi-fullscreen"></i>
                </button>

                <Dropdown
                  isOpen={menu}
                  toggle={() => setMenu(!menu)}
                  className="d-inline-block"
                >
                  <DropdownToggle
                    className="btn header-item waves-effect"
                    id="page-header-user-dropdown"
                    tag="button"
                  >
                    <i className="mdi mdi-account-circle font-size-24 align-middle me-1"></i>
                    <span className="d-none d-xl-inline-block ms-1">
                      {username}
                    </span>
                    <i className="mdi mdi-chevron-down d-none d-xl-inline-block"></i>
                  </DropdownToggle>
                  <DropdownMenu className="dropdown-menu-end">
                    <Link to="/logout" className="dropdown-item text-danger">
                      <i className="mdi mdi-logout font-size-16 align-middle me-1 text-danger"></i>
                      <span>Logout</span>
                    </Link>
                  </DropdownMenu>
                </Dropdown>
              </div>
            </div>
          </Container>
        </div>
      </header>
    </React.Fragment>
  );
};

Header.propTypes = {
  changeSidebarType: PropTypes.func,
  leftMenu: PropTypes.any,
  leftSideBarType: PropTypes.any,
  t: PropTypes.any,
  toggleLeftmenu: PropTypes.func,
};

const mapStatetoProps = (state) => {
  const { layoutType, leftMenu, leftSideBarType } = state.Layout;

  return {
    layoutType,
    leftMenu,
    leftSideBarType,
  };
};

export default connect(mapStatetoProps, {
  toggleLeftmenu,
  changeSidebarType,
})(withTranslation()(Header));