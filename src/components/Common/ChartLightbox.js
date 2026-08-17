import React from "react"
import PropTypes from "prop-types"
import { Modal, ModalBody } from "reactstrap"

/** Fullscreen chart image viewer with a close button, so levels are legible. */
const ChartLightbox = ({ url, isOpen, toggle }) => {
  if (!url) return null

  return (
    <Modal isOpen={isOpen} toggle={toggle} size="xl" centered contentClassName="bg-dark">
      <button
        type="button"
        className="btn-close btn-close-white position-absolute"
        style={{ top: "1rem", right: "1rem", zIndex: 1 }}
        aria-label="Close"
        onClick={toggle}
      ></button>
      <ModalBody className="p-2 text-center">
        <img src={url} alt="Chart" style={{ maxWidth: "100%", height: "auto" }} />
      </ModalBody>
    </Modal>
  )
}

ChartLightbox.propTypes = {
  url: PropTypes.string,
  isOpen: PropTypes.bool.isRequired,
  toggle: PropTypes.func.isRequired,
}

export default ChartLightbox
