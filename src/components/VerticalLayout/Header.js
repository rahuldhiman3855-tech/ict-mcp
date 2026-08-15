import PropTypes from "prop-types";
import React, { useState } from "react";

import { connect } from "react-redux";
import { Form, Input, Button, Row, Col, Container } from "reactstrap";

import { Link } from "react-router-dom";
import { withTranslation } from "react-i18next";

import {
  showRightSidebarAction,
  toggleLeftmenu,
  changeSidebarType,
} from "../../store/actions";

const icon = "/icon.svg";

const Header = (props) => {
  function toggleFullscreen() {
    if (
      !document.fullscreenElement &&
      /* alternative standard method */ !document.mozFullScreenElement &&
      !document.webkitFullscreenElement
    ) {
      // current working methods
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
    var body = document.body;
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
            <div className="float-end">
              <button
                type="button"
                onClick={() => {
                  toggleFullscreen();
                }}
                className="btn header-item noti-icon waves-effect me-2"
                data-toggle="fullscreen"
                title="Toggle fullscreen"
              >
                <i className="mdi mdi-fullscreen"></i>
              </button>
              <button
                type="button"
                className="btn header-item noti-icon right-bar-toggle waves-effect"
                onClick={() => {
                  props.showRightSidebarAction(!props.showRightSidebar);
                }}
                title="Settings"
              >
                <i className="mdi mdi-settings-outline"></i>
              </button>
            </div>
            <div>
              <div className="navbar-brand-box">
                <Link to="/" className="logo">
                  <span className="logo-lg">
                    <img src={icon} alt="ICT Cron Manager" height="68" />
                  </span>
                </Link>
              </div>
              <button
              type="button"
              className="btn btn-sm px-3 font-size-16 d-lg-none header-item waves-effect waves-light"
              data-toggle="collapse"
              onClick={() => {
                tToggle()
              }}
              data-target="#topnav-menu-content"
            >
              <i className="fa fa-fw fa-bars"></i>
            </button>
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
  showRightSidebar: PropTypes.any,
  showRightSidebarAction: PropTypes.func,
  t: PropTypes.any,
  toggleLeftmenu: PropTypes.func,
};

const mapStatetoProps = (state) => {
  const { layoutType, showRightSidebar, leftMenu, leftSideBarType } =
    state.Layout;
  return { layoutType, showRightSidebar, leftMenu, leftSideBarType };
};

export default connect(mapStatetoProps, {
  showRightSidebarAction,
  toggleLeftmenu,
  changeSidebarType,
})(withTranslation()(Header));
